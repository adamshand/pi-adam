import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readViewState, writeViewState } from "../herdr-plugin/view-state.js";
import { createIdea, deleteIdea, listIdeas, promoteIdea, updateIdea } from "../herdr-plugin/idea-store.js";
import { clearCompleted, createTodo, isCompleted, listTodos, SESSION_TAG_PREFIX, sessionTag } from "../herdr-plugin/todo-store.js";

type TodoView = "session" | "all";
type BoardView = TodoView | "ideas";
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
const INITIAL_BOARD_RESIZE = "0.17"; // Default 50/50 split becomes approximately 67/33.

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

function todoSnapshot(cwd: string, view: TodoView, sessionId: string): TodoSnapshot {
	const todos = listTodos(cwd, { scope: view === "all" ? "project" : "session", sessionId }) as TodoRecord[];
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
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nTodo discipline:\n- Treat todos as a durable ledger of actionable commitments, not a transcript of every mechanical step.\n- Use the idea tool for explicitly discussed future possibilities that are worth remembering but are not current commitments; ideas are not unfinished todos.\n- For non-trivial committed work, normally maintain 3–7 outcome-level todos rather than one umbrella ticket or many tiny implementation tickets.\n- Give each todo or idea an independently understandable title. Keep its body concise: why it matters, key constraints, acceptance criteria, and only tightly related checklist steps.\n- Add, update, split, promote, or close items as commitments change during the conversation.\n- Before settling, reconcile todos and ideas against the conversation so no promised outcome or explicitly captured future possibility is forgotten and statuses remain accurate.`,
	}));

	pi.registerTool?.({
		name: "idea",
		label: "Idea",
		description: "Capture a non-actionable possibility for future project work",
		promptSnippet: "Capture a project idea that is worth remembering but is not a current commitment",
		promptGuidelines: ["Use idea only for explicitly discussed future possibilities; use todo for committed actionable work."],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("update"), Type.Literal("delete"), Type.Literal("promote")]),
			id: Type.Optional(Type.String({ description: "Idea ID for update, delete, or promote" })),
			title: Type.Optional(Type.String({ description: "Short independently understandable idea title" })),
			body: Type.Optional(Type.String({ description: "Concise context explaining why the idea may matter" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const ideas = listIdeas(ctx.cwd);
				const text = ideas.length > 0 ? ideas.map((idea) => `${idea.id}: ${idea.title}`).join("\n") : "No ideas";
				return { content: [{ type: "text" as const, text }], details: { action: "list", count: ideas.length } };
			}
			if (params.action === "create") {
				const title = params.title?.trim();
				if (!title) return { content: [{ type: "text" as const, text: "Error: idea title is required" }], details: { error: "title required" } };
				const idea = createIdea(ctx.cwd, { title, body: params.body?.trim() ?? "" });
				return {
					content: [{ type: "text" as const, text: `Captured idea: ${idea.title}` }],
					details: { action: "create", id: idea.id, title: idea.title },
				};
			}
			if (!params.id) return { content: [{ type: "text" as const, text: "Error: idea ID is required" }], details: { error: "id required" } };
			if (params.action === "update") {
				const idea = updateIdea(ctx.cwd, params.id, { title: params.title, body: params.body?.trim() });
				return idea
					? { content: [{ type: "text" as const, text: `Updated idea: ${idea.title}` }], details: { action: "update", id: idea.id } }
					: { content: [{ type: "text" as const, text: `Idea not found: ${params.id}` }], details: { error: "not found" } };
			}
			if (params.action === "promote") {
				const promoted = promoteIdea(ctx.cwd, params.id, ctx.sessionManager.getSessionId());
				if (!promoted) return { content: [{ type: "text" as const, text: `Idea not found: ${params.id}` }], details: { error: "not found" } };
				await reconcile(ctx, { force: true });
				return { content: [{ type: "text" as const, text: `Promoted idea to session todo: ${promoted.todo.title}` }], details: { action: "promote", id: promoted.todo.id } };
			}
			const idea = deleteIdea(ctx.cwd, params.id);
			return idea
				? { content: [{ type: "text" as const, text: `Deleted idea: ${idea.title}` }], details: { action: "delete", id: idea.id } }
				: { content: [{ type: "text" as const, text: `Idea not found: ${params.id}` }], details: { error: "not found" } };
		},
	});

	let interval: ReturnType<typeof setInterval> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	let opening = false;
	let reconciling = false;
	let open = false;
	let boardPaneId: string | undefined;
	let currentSessionId = "";
	let viewStatePath = "";
	let viewState: { view: BoardView; lastTodoView: TodoView } = { view: "session", lastTodoView: "session" };
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

	const openBoard = async (ctx: ExtensionContext, automatic = false): Promise<boolean> => {
		if (opening || !currentSessionId) return open;
		opening = true;
		try {
			if (automatic && viewState.view === "ideas") {
				viewState = { view: viewState.lastTodoView, lastTodoView: viewState.lastTodoView };
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

			// Plugin commands run from the plugin root; overriding cwd would hide board.js.
			const result = await runHerdr(args);
			const paneId = parseJson<PluginPaneOpenResponse>(result.stdout)?.result?.plugin_pane?.pane?.pane_id;
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
		// A user may already have closed the pane with q; either way our desired state is closed.
		open = false;
		boardPaneId = undefined;
		return result.ok;
	};

	const reconcile = async (ctx: ExtensionContext, options: { force?: boolean } = {}): Promise<void> => {
		if (!isHerdrPane() || reconciling || !currentSessionId) return;
		reconciling = true;
		try {
			const sharedState = readViewState(viewStatePath, viewState.view) as { view: BoardView; lastTodoView: TodoView };
			const viewChanged = sharedState.view !== viewState.view || sharedState.lastTodoView !== viewState.lastTodoView;
			viewState = sharedState;
			const actionableView = viewState.view === "ideas" ? viewState.lastTodoView : viewState.view;
			const current = todoSnapshot(ctx.cwd, actionableView, currentSessionId);
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
		const projectKey = createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 12);
		// Keep the old filename so readViewState can migrate plain "session"/"project" values.
		viewStatePath = join(tmpdir(), "pi-adam-herdr-todos", projectKey, `${currentSessionId}.scope`);
		viewState = readViewState(viewStatePath, "session") as { view: BoardView; lastTodoView: TodoView };
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

	const toggleBoard = async (ctx: ExtensionContext): Promise<void> => {
		await refreshOpenState();
		if (open) {
			visibility = "hidden";
			await closeBoard();
		} else {
			visibility = "shown";
			await reconcile(ctx, { force: true });
		}
		ctx.ui.notify(`pi-adam: todo board ${open ? "shown" : "hidden"}`, "info");
	};

	pi.registerShortcut?.("alt+t", {
		description: "Toggle the Herdr todo pane",
		handler: toggleBoard,
	});

	pi.registerCommand("idea", {
		description: "Capture a non-actionable project idea",
		handler: async (args, ctx) => {
			let title = args.trim();
			if (!title) {
				const entered = await ctx.ui.input("Capture project idea", "Idea title");
				if (entered === undefined) return;
				title = entered.trim();
				if (!title) return;
			}
			createIdea(ctx.cwd, { title });
			ctx.ui.notify(`Captured idea: ${title}`, "info");
		},
	});

	pi.registerCommand("todo", {
		description: "Add a session todo; use --project for project scope",
		getArgumentCompletions(prefix) {
			return "--project".startsWith(prefix.trim()) ? [{ value: "--project ", label: "--project", description: "Add a project-wide todo" }] : [];
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			const projectWide = input === "--project" || input.startsWith("--project ");
			let title = projectWide ? input.slice("--project".length).trim() : input;
			if (!title) {
				const entered = await ctx.ui.input(projectWide ? "Add project todo" : "Add session todo", "Todo title");
				if (entered === undefined) return;
				title = entered.trim();
				if (!title) return;
			}
			createTodo(ctx.cwd, { title, tags: projectWide ? ["project"] : [sessionTag(currentSessionId)] });
			await reconcile(ctx, { force: true });
			ctx.ui.notify(`Added todo: ${title}`, "info");
		},
	});

	pi.registerCommand("herdr-todos", {
		description: "Control the session-scoped Herdr todo board",
		getArgumentCompletions(prefix) {
			return ["toggle", "auto", "view session", "view all", "view ideas", "scope session", "scope project", "clear", "open", "close", "refresh", "status"]
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
				await toggleBoard(ctx);
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
				const opened = await openBoard(ctx, false);
				ctx.ui.notify(opened ? "pi-adam: todo board opened" : "pi-adam: could not open todo board", opened ? "info" : "error");
				return;
			}
			if (action === "close") {
				visibility = "hidden";
				await closeBoard();
				ctx.ui.notify("pi-adam: todo board hidden", "info");
				return;
			}
			if (action === "view" || action === "scope") {
				const requested = action === "scope" && value === "project" ? "all" : value;
				if (requested !== "session" && requested !== "all" && requested !== "ideas") {
					ctx.ui.notify("Usage: /herdr-todos view session|all|ideas", "warning");
					return;
				}
				viewState = {
					view: requested,
					lastTodoView: requested === "ideas" ? viewState.lastTodoView : requested,
				};
				writeViewState(viewStatePath, viewState);
				lastSignature = undefined;
				await reconcile(ctx, { force: true });
				ctx.ui.notify(`pi-adam: showing ${requested}`, "info");
				return;
			}
			if (action === "clear") {
				if (viewState.view === "ideas") {
					ctx.ui.notify("pi-adam: ideas are dismissed individually", "info");
					return;
				}
				const actionableView = viewState.view;
				const scope = actionableView === "all" ? "project" : "session";
				const completed = (listTodos(ctx.cwd, { scope, sessionId: currentSessionId }) as TodoRecord[]).filter((todo) => isCompleted(todo));
				if (completed.length === 0) {
					ctx.ui.notify(`pi-adam: no completed ${actionableView} todos to clear`, "info");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Clear completed todos?",
					`Delete ${completed.length} completed ${actionableView} todo${completed.length === 1 ? "" : "s"}?`,
				);
				if (!confirmed) return;
				const deleted = clearCompleted(ctx.cwd, { scope, sessionId: currentSessionId });
				lastSignature = undefined;
				await reconcile(ctx, { force: true });
				ctx.ui.notify(`pi-adam: cleared ${deleted.length} completed ${actionableView} todo${deleted.length === 1 ? "" : "s"}`, "info");
				return;
			}
			if (action === "refresh") {
				await reconcile(ctx, { force: true });
				ctx.ui.notify("pi-adam: todo board refreshed", "info");
				return;
			}
			const actionableView = viewState.view === "ideas" ? viewState.lastTodoView : viewState.view;
			const current = todoSnapshot(ctx.cwd, actionableView, currentSessionId);
			ctx.ui.notify(
				`pi-adam: ${current.done}/${current.total} ${actionableView} todos done; ${current.active} active; view ${viewState.view}; board ${open ? "open" : "closed"}; visibility ${visibility}`,
				"info",
			);
		},
	});
}
