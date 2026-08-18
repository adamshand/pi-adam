import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { readViewState, writeViewState, type BoardViewState } from "../herdr/todos/view-state.js";
import { clearCompleted, isCompleted, listTodos, migrateLegacyWorkItems, type Todo } from "../herdr/todos/work-item-store.js";
type Visibility = "auto" | "shown" | "hidden";

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

const PaneRecordSchema = Type.Object({
	label: Type.Optional(Type.String()),
	pane_id: Type.Optional(Type.String()),
});

const PaneListResponseSchema = Type.Object({
	result: Type.Optional(Type.Object({
		panes: Type.Optional(Type.Array(PaneRecordSchema)),
	})),
});

const PluginPaneOpenResponseSchema = Type.Object({
	result: Type.Optional(Type.Object({
		plugin_pane: Type.Optional(Type.Object({
			pane: Type.Optional(PaneRecordSchema),
		})),
	})),
});

const PLUGIN_ID = "pi-adam.todos";
const PANE_ENTRYPOINT = "board";
const REFRESH_MS = 1500;
const CLOSE_DELAY_MS = 1500;
const INITIAL_BOARD_RESIZE = "0.17";

function isHerdrPane(): boolean {
	return process.env.HERDR_ENV === "1";
}

function parsePaneListResponse(text: string) {
	try {
		return Parse(PaneListResponseSchema, JSON.parse(text));
	} catch {
		return undefined;
	}
}

function parsePluginPaneOpenResponse(text: string) {
	try {
		return Parse(PluginPaneOpenResponseSchema, JSON.parse(text));
	} catch {
		return undefined;
	}
}

function boardLabel(sessionId: string): string {
	return `Todo · ${sessionId.slice(0, 8)}`;
}

function todoSnapshot(cwd: string, sessionId: string): TodoSnapshot {
	const todos: Todo[] = listTodos(cwd, { sessionId });
	const done = todos.filter((todo) => isCompleted(todo)).length;
	return {
		total: todos.length,
		done,
		active: todos.length - done,
		signature: todos
			.map((todo) => `${todo.id}:${todo.status}:${todo.updatedAt}`)
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
	let viewStatePath = "";
	let viewState: BoardViewState = { view: "todos" };
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
		return parsePaneListResponse(result.stdout)?.result?.panes?.find((pane) => pane.label === wantedLabel)?.pane_id;
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

	const openBoard = async (ctx: ExtensionContext, automatic = false): Promise<boolean> => {
		if (opening || !currentSessionId) return open;
		opening = true;
		try {
			if (automatic && viewState.view === "ideas") {
				viewState = { view: "todos" };
				writeViewState(viewStatePath, viewState);
			}
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
				"--env", `PI_ADAM_TODO_VIEW=${viewState.view}`,
				"--env", `PI_ADAM_TODO_STATE_PATH=${viewStatePath}`,
				"--no-focus",
			];
			const sourcePane = process.env.HERDR_PANE_ID;
			if (sourcePane) args.push("--target-pane", sourcePane);
			const result = await runHerdr(args);
			const paneId = parsePluginPaneOpenResponse(result.stdout)?.result?.plugin_pane?.pane?.pane_id;
			open = result.ok && paneId !== undefined;
			boardPaneId = open ? paneId : undefined;
			if (boardPaneId) {
				await runHerdr(["pane", "resize", "--pane", boardPaneId, "--direction", "right", "--amount", INITIAL_BOARD_RESIZE]);
				await runHerdr(["pane", "rename", boardPaneId, boardLabel(currentSessionId)]);
			}
			return open;
		} finally {
			opening = false;
		}
	};

	const closeBoard = async (): Promise<boolean> => {
		if (!open || !boardPaneId) return false;
		const result = await runHerdr(["plugin", "pane", "close", boardPaneId]);
		open = false;
		boardPaneId = undefined;
		return result.ok;
	};

	const reconcile = async (ctx: ExtensionContext, options: { force?: boolean } = {}): Promise<void> => {
		if (!isHerdrPane() || reconciling || !currentSessionId) return;
		reconciling = true;
		try {
			const sharedState = readViewState(viewStatePath, viewState.view);
			const viewChanged = sharedState.view !== viewState.view;
			viewState = sharedState;
			const current = todoSnapshot(ctx.cwd, currentSessionId);
			const changed = viewChanged || current.signature !== lastSignature;
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
				if (!open && (changed || options.force || visibility === "shown")) await openBoard(ctx, visibility !== "shown");
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

	pi.on("session_start", async (_event, ctx) => {
		migrateLegacyWorkItems(ctx.cwd);
		currentSessionId = ctx.sessionManager.getSessionId();
		const projectKey = createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 12);
		viewStatePath = join(tmpdir(), "pi-adam-herdr-todos", projectKey, `${currentSessionId}.view`);
		viewState = readViewState(viewStatePath, "todos");
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
		if (event.toolName === "todo" || event.toolName === "idea") await reconcile(ctx, { force: true });
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await reconcile(ctx);
		if (visibility === "hidden" && lastActive > 0) {
			ctx.ui.notify(`pi-adam: ${lastActive} hidden Todo${lastActive === 1 ? "" : "s"} still unfinished`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		if (interval) clearInterval(interval);
		if (closeTimer) clearTimeout(closeTimer);
		interval = undefined;
		closeTimer = undefined;
		if (open) await closeBoard();
	});

	const toggleBoard = async (ctx: ExtensionContext): Promise<void> => {
		await refreshOpenState();
		if (open) {
			visibility = "hidden";
			await closeBoard();
		} else {
			visibility = "shown";
			await reconcile(ctx, { force: true });
		}
		ctx.ui.notify(`pi-adam: Todo board ${open ? "shown" : "hidden"}`, "info");
	};

	pi.registerShortcut?.("alt+t", {
		description: "Toggle the Herdr Todo pane",
		handler: toggleBoard,
	});

	pi.registerCommand("todos", {
		description: "Open and control the Herdr Todos and Ideas board",
		getArgumentCompletions(prefix) {
			return ["toggle", "auto", "view todos", "view ideas", "clear", "open", "close", "refresh", "status"]
				.filter((value) => value.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			if (!isHerdrPane()) {
				ctx.ui.notify("pi-adam: /todos requires Herdr", "warning");
				return;
			}
			const [action = "open", value] = args.trim().split(/\s+/, 2);
			if (action === "toggle") {
				await toggleBoard(ctx);
				return;
			}
			if (action === "auto") {
				visibility = "auto";
				await reconcile(ctx, { force: true });
				ctx.ui.notify("pi-adam: Todo board visibility is automatic", "info");
				return;
			}
			if (action === "open") {
				visibility = "shown";
				const opened = await openBoard(ctx, false);
				ctx.ui.notify(opened ? "pi-adam: Todo board opened" : "pi-adam: could not open Todo board", opened ? "info" : "error");
				return;
			}
			if (action === "close") {
				visibility = "hidden";
				await closeBoard();
				ctx.ui.notify("pi-adam: Todo board hidden", "info");
				return;
			}
			if (action === "view") {
				if (value !== "todos" && value !== "ideas") {
					ctx.ui.notify("Usage: /todos view todos|ideas", "warning");
					return;
				}
				viewState = { view: value };
				writeViewState(viewStatePath, viewState);
				await reconcile(ctx, { force: true });
				ctx.ui.notify(`pi-adam: showing ${value}`, "info");
				return;
			}
			if (action === "clear") {
				if (viewState.view === "ideas") {
					ctx.ui.notify("pi-adam: Ideas are dismissed individually", "info");
					return;
				}
				const completed = listTodos(ctx.cwd, { sessionId: currentSessionId }).filter((todo) => isCompleted(todo));
				if (completed.length === 0) {
					ctx.ui.notify("pi-adam: no completed Todos to clear", "info");
					return;
				}
				const confirmed = await ctx.ui.confirm("Clear completed Todos?", `Delete ${completed.length} completed Todo${completed.length === 1 ? "" : "s"}?`);
				if (!confirmed) return;
				const deleted = clearCompleted(ctx.cwd, { sessionId: currentSessionId });
				lastSignature = undefined;
				await reconcile(ctx, { force: true });
				ctx.ui.notify(`pi-adam: cleared ${deleted.length} completed Todo${deleted.length === 1 ? "" : "s"}`, "info");
				return;
			}
			if (action === "refresh") {
				await reconcile(ctx, { force: true });
				ctx.ui.notify("pi-adam: Todo board refreshed", "info");
				return;
			}
			if (action !== "status") {
				ctx.ui.notify("Usage: /todos [open|toggle|auto|view todos|view ideas|clear|close|refresh|status]", "warning");
				return;
			}
			const current = todoSnapshot(ctx.cwd, currentSessionId);
			ctx.ui.notify(`pi-adam: ${current.done}/${current.total} Todos done; ${current.active} active; view ${viewState.view}; board ${open ? "open" : "closed"}; visibility ${visibility}`, "info");
		},
	});
}
