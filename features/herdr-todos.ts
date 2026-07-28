import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearCompleted, isCompleted, listTodos, SESSION_TAG_PREFIX, sessionTag } from "../herdr-plugin/todo-store.js";

type Scope = "session" | "project";
type Visibility = "auto" | "shown" | "hidden";

type TodoRecord = {
	id: string;
	status: string;
	assignedToSession?: string;
};

type TodoSnapshot = {
	total: number;
	done: number;
	active: number;
	signature: string;
};

type HerdrResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
};

type PaneRecord = {
	label?: string;
	pane_id?: string;
};

type PaneListResponse = {
	result?: { panes?: PaneRecord[] };
};

type PluginPaneOpenResponse = {
	result?: { plugin_pane?: { pane?: PaneRecord } };
};

const PLUGIN_ID = "pi-adam.todos";
const PANE_ENTRYPOINT = "board";
const REFRESH_MS = 1500;
const CLOSE_DELAY_MS = 1500;

function isHerdrPane(): boolean {
	return process.env.HERDR_ENV === "1";
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function boardLabel(sessionId: string): string {
	return `Pi Todos · ${sessionId.slice(0, 8)}`;
}

function todoSnapshot(cwd: string, scope: Scope, sessionId: string): TodoSnapshot {
	const todos = listTodos(cwd, { scope, sessionId }) as TodoRecord[];
	const done = todos.filter((todo) => isCompleted(todo)).length;
	return {
		total: todos.length,
		done,
		active: todos.length - done,
		signature: todos
			.map((todo) => `${todo.id}:${todo.status}:${todo.assignedToSession ?? ""}`)
			.sort()
			.join("|"),
	};
}

export function registerHerdrTodosFeature(pi: ExtensionAPI): void {
	let interval: ReturnType<typeof setInterval> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	let opening = false;
	let reconciling = false;
	let open = false;
	let boardPaneId: string | undefined;
	let currentSessionId = "";
	let scope: Scope = "session";
	let visibility: Visibility = "auto";
	let lastSignature: string | undefined;
	let lastActive = 0;

	const runHerdr = async (args: string[]): Promise<HerdrResult> => {
		if (!isHerdrPane()) return { ok: false, stdout: "", stderr: "not inside Herdr" };
		try {
			const result = await pi.exec("herdr", args, { timeout: 5000 });
			return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
	};

	const findExistingBoard = async (): Promise<string | undefined> => {
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		if (!workspaceId || !currentSessionId) return undefined;
		const result = await runHerdr(["pane", "list", "--workspace", workspaceId]);
		if (!result.ok) return undefined;
		const wantedLabel = boardLabel(currentSessionId);
		return parseJson<PaneListResponse>(result.stdout)?.result?.panes?.find((pane) => pane.label === wantedLabel)?.pane_id;
	};

	const refreshOpenState = async (): Promise<void> => {
		if (!open || !boardPaneId) return;
		const result = await runHerdr(["pane", "get", boardPaneId]);
		if (result.ok) return;
		open = false;
		boardPaneId = undefined;
	};

	const reportMetadata = async (current: TodoSnapshot): Promise<void> => {
		const paneId = process.env.HERDR_PANE_ID;
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		if (!paneId || !workspaceId) return;
		const token = current.total === 0 ? "none" : `${current.done}/${current.total} done`;
		await Promise.all([
			runHerdr(["pane", "report-metadata", paneId, "--source", PLUGIN_ID, "--token", `todos=${token}`]),
			runHerdr(["workspace", "report-metadata", workspaceId, "--source", PLUGIN_ID, "--token", `todos=${token}`]),
		]);
	};

	const openBoard = async (ctx: ExtensionContext): Promise<boolean> => {
		if (opening || !currentSessionId) return open;
		opening = true;
		try {
			const existingPaneId = await findExistingBoard();
			if (existingPaneId) {
				boardPaneId = existingPaneId;
				open = true;
				return true;
			}

			const args = [
				"plugin", "pane", "open",
				"--plugin", PLUGIN_ID,
				"--entrypoint", PANE_ENTRYPOINT,
				"--placement", "split",
				"--direction", "right",
				"--env", `PI_ADAM_TODO_CWD=${ctx.cwd}`,
				"--env", `PI_ADAM_TODO_SESSION_ID=${currentSessionId}`,
				"--env", `PI_ADAM_TODO_SCOPE=${scope}`,
				"--no-focus",
			];
			const sourcePane = process.env.HERDR_PANE_ID;
			if (sourcePane) args.push("--target-pane", sourcePane);

			// Plugin commands run from the plugin root; overriding cwd would hide board.js.
			const result = await runHerdr(args);
			const paneId = parseJson<PluginPaneOpenResponse>(result.stdout)?.result?.plugin_pane?.pane?.pane_id;
			open = result.ok && paneId !== undefined;
			boardPaneId = open ? paneId : undefined;
			if (boardPaneId) await runHerdr(["pane", "rename", boardPaneId, boardLabel(currentSessionId)]);
			return open;
		} finally {
			opening = false;
		}
	};

	const closeBoard = async (): Promise<boolean> => {
		if (!open || !boardPaneId) return false;
		const result = await runHerdr(["plugin", "pane", "close", boardPaneId]);
		// A user may already have closed the pane with q; either way our desired state is closed.
		open = false;
		boardPaneId = undefined;
		return result.ok;
	};

	const reconcile = async (ctx: ExtensionContext, options: { force?: boolean } = {}): Promise<void> => {
		if (!isHerdrPane() || reconciling || !currentSessionId) return;
		reconciling = true;
		try {
			const current = todoSnapshot(ctx.cwd, scope, currentSessionId);
			const changed = current.signature !== lastSignature;
			lastSignature = current.signature;
			lastActive = current.active;

			if (changed || options.force) await Promise.all([reportMetadata(current), refreshOpenState()]);

			if (visibility === "hidden") {
				if (closeTimer) clearTimeout(closeTimer);
				closeTimer = undefined;
				if (open) await closeBoard();
				return;
			}

			if (visibility === "shown" || current.active > 0) {
				if (closeTimer) clearTimeout(closeTimer);
				closeTimer = undefined;
				if (!open && (changed || options.force || visibility === "shown")) await openBoard(ctx);
				return;
			}

			if (open && (changed || options.force)) {
				if (closeTimer) clearTimeout(closeTimer);
				closeTimer = setTimeout(() => {
					closeTimer = undefined;
					void closeBoard();
				}, current.total === 0 ? 0 : CLOSE_DELAY_MS);
			}
		} finally {
			reconciling = false;
		}
	};

	pi.on("tool_call", (event) => {
		if (!event.toolName.toLowerCase().includes("todo") || !currentSessionId) return;
		const input = event.input as { action?: unknown; tags?: unknown };
		if (input.action !== "create") return;
		const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
		if (tags.includes("project") || tags.some((tag) => tag.startsWith(SESSION_TAG_PREFIX))) return;
		input.tags = [...tags, sessionTag(currentSessionId)];
	});

	pi.on("session_start", async (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		scope = "session";
		visibility = "auto";
		open = false;
		opening = false;
		reconciling = false;
		boardPaneId = undefined;
		lastSignature = undefined;
		lastActive = 0;
		await reconcile(ctx, { force: true });
		interval = setInterval(() => void reconcile(ctx), REFRESH_MS);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName.toLowerCase().includes("todo")) await reconcile(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await reconcile(ctx);
		if (visibility === "hidden" && lastActive > 0) {
			ctx.ui.notify(`pi-adam: ${lastActive} hidden todo${lastActive === 1 ? "" : "s"} still unfinished`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		if (interval) clearInterval(interval);
		if (closeTimer) clearTimeout(closeTimer);
		interval = undefined;
		closeTimer = undefined;
		if (open) await closeBoard();
	});

	pi.registerCommand("herdr-todos", {
		description: "Control the session-scoped Herdr todo board",
		getArgumentCompletions(prefix) {
			return ["toggle", "auto", "scope session", "scope project", "clear", "open", "close", "refresh", "status"]
				.filter((value) => value.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			if (!isHerdrPane()) {
				ctx.ui.notify("pi-adam: not running inside Herdr", "warning");
				return;
			}
			const [action = "status", value] = args.trim().split(/\s+/, 2);

			if (action === "toggle") {
				if (visibility === "hidden") {
					visibility = "shown";
					await reconcile(ctx, { force: true });
				} else {
					visibility = "hidden";
					await closeBoard();
				}
				ctx.ui.notify(`pi-adam: todo board ${visibility === "hidden" ? "hidden" : "shown"}`, "info");
				return;
			}
			if (action === "auto") {
				visibility = "auto";
				await reconcile(ctx, { force: true });
				ctx.ui.notify("pi-adam: todo board visibility is automatic", "info");
				return;
			}
			if (action === "open") {
				visibility = "shown";
				const opened = await openBoard(ctx);
				ctx.ui.notify(opened ? "pi-adam: todo board opened" : "pi-adam: could not open todo board", opened ? "info" : "error");
				return;
			}
			if (action === "close") {
				visibility = "hidden";
				await closeBoard();
				ctx.ui.notify("pi-adam: todo board hidden", "info");
				return;
			}
			if (action === "scope") {
				if (value !== "session" && value !== "project") {
					ctx.ui.notify("Usage: /herdr-todos scope session|project", "warning");
					return;
				}
				if (scope !== value) {
					scope = value;
					lastSignature = undefined;
					if (open) await closeBoard();
					await reconcile(ctx, { force: true });
				}
				ctx.ui.notify(`pi-adam: showing ${scope} todos`, "info");
				return;
			}
			if (action === "clear") {
				const completed = (listTodos(ctx.cwd, { scope, sessionId: currentSessionId }) as TodoRecord[]).filter((todo) => isCompleted(todo));
				if (completed.length === 0) {
					ctx.ui.notify(`pi-adam: no completed ${scope} todos to clear`, "info");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Clear completed todos?",
					`Delete ${completed.length} completed ${scope} todo${completed.length === 1 ? "" : "s"}?`,
				);
				if (!confirmed) return;
				const deleted = clearCompleted(ctx.cwd, { scope, sessionId: currentSessionId });
				lastSignature = undefined;
				await reconcile(ctx, { force: true });
				ctx.ui.notify(`pi-adam: cleared ${deleted.length} completed ${scope} todo${deleted.length === 1 ? "" : "s"}`, "info");
				return;
			}
			if (action === "refresh") {
				await reconcile(ctx, { force: true });
				ctx.ui.notify("pi-adam: todo board refreshed", "info");
				return;
			}
			const current = todoSnapshot(ctx.cwd, scope, currentSessionId);
			ctx.ui.notify(
				`pi-adam: ${current.done}/${current.total} ${scope} todos done; ${current.active} active; board ${open ? "open" : "closed"}; visibility ${visibility}`,
				"info",
			);
		},
	});
}
