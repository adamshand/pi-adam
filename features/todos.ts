import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	completeTodo,
	createIdea,
	createTodo,
	deferTodo,
	deleteIdea,
	deleteWorkItem,
	getWorkItem,
	isCompleted,
	listIdeas,
	listTodos,
	migrateLegacyWorkItems,
	normalizeTodoStatus,
	normalizeWorkItemId,
	promoteIdea,
	reopenTodo,
	setTodoStatus,
	startTodo,
	updateWorkItem,
	workItemPath,
} from "../herdr/todos/work-item-store.js";

function displayId(item: { id: string; kind: string }): string {
	return `${item.kind === "idea" ? "IDEA" : "TODO"}-${normalizeWorkItemId(item.id)}`;
}

function serializeItem(item: any) {
	return {
		id: displayId(item),
		kind: item.kind,
		title: item.title,
		intent: item.intent || undefined,
		progress: item.progress || undefined,
		checklist: item.checklist.length > 0 ? item.checklist : undefined,
		...(item.kind === "todo" ? { status: item.status, owner_session_id: item.ownerSessionId } : {}),
		created_in_session_id: item.createdInSessionId,
		created_at: item.createdAt,
		updated_at: item.updatedAt,
	};
}

function sessionTodo(cwd: string, id: string, sessionId: string) {
	const item = getWorkItem(cwd, id);
	return item?.kind === "todo" && item.ownerSessionId === sessionId ? item : undefined;
}

export function registerTodosFeature(pi: ExtensionAPI): void {
	const checklistLeaf = Type.Object({
		text: Type.String({ description: "Concrete checklist outcome" }),
		done: Type.Optional(Type.Boolean()),
	});
	const checklistItem = Type.Object({
		text: Type.String({ description: "Concrete checklist outcome or group" }),
		done: Type.Optional(Type.Boolean()),
		items: Type.Optional(Type.Array(checklistLeaf, { description: "Optional nested checklist outcomes" })),
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nTodo discipline:\n- Treat Todos as active commitments owned by the current Pi session, not a transcript of every mechanical step.\n- Use Ideas for project-wide possibilities, follow-ups, or future commitments that are not active in this session.\n- For non-trivial committed work, normally maintain 3–7 outcome-level Todos rather than one umbrella item or many tiny implementation items.\n- Record concise intent, current progress, and outcome-oriented checklist items when they improve clarity.\n- Use start, complete, and reopen to maintain the ready → in progress → done lifecycle.\n- Promote an Idea when accepting it into the current session; defer an unfinished Todo when it should return to Ideas.\n- Before settling, reconcile Todos and Ideas against the conversation so intent, progress, and status remain accurate.`,
	}));

	pi.on("session_start", (_event, ctx) => {
		const migrated = migrateLegacyWorkItems(ctx.cwd);
		if (migrated.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`pi-adam: migrated ${migrated.length} legacy work item${migrated.length === 1 ? "" : "s"}`, "info");
		}
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage structured Todos owned by the current Pi session. Actions: list active Todos, list-all including done Todos, get, create, update, delete, start, complete, reopen, and defer a Todo back to project Ideas.",
		promptSnippet: "Manage active commitments owned by the current Pi session",
		promptGuidelines: ["Use Todo for active session commitments and Idea for project-wide work retained for later."],
		parameters: Type.Object({
			action: StringEnum(["list", "list-all", "get", "create", "update", "delete", "start", "complete", "reopen", "defer"] as const),
			id: Type.Optional(Type.String({ description: "Todo ID (TODO-<hex> or raw ID)" })),
			title: Type.Optional(Type.String({ description: "Short independently understandable Todo title" })),
			intent: Type.Optional(Type.String({ description: "Concise desired outcome and why it matters" })),
			progress: Type.Optional(Type.String({ description: "Concise current progress or next constraint" })),
			checklist: Type.Optional(Type.Array(checklistItem, { description: "Outcome-oriented checklist, optionally nested one level" })),
			status: Type.Optional(StringEnum(["ready", "in_progress", "done"] as const, { description: "Todo status; prefer start, complete, and reopen actions for transitions" })),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { status?: unknown };
			if (typeof input.status !== "string") return args;
			return { ...input, status: normalizeTodoStatus(input.status) };
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.action === "list" || params.action === "list-all") {
				const todos = listTodos(ctx.cwd, { sessionId }).filter((todo) => params.action === "list-all" || !isCompleted(todo));
				return { content: [{ type: "text" as const, text: todos.length ? JSON.stringify(todos.map(serializeItem), null, 2) : "No todos" }], details: { action: params.action, count: todos.length } };
			}
			if (params.action === "create") {
				const title = params.title?.trim();
				if (!title) return { content: [{ type: "text" as const, text: "Error: Todo title is required" }], details: { error: "title required" } };
				const todo = createTodo(ctx.cwd, { title, intent: params.intent ?? "", progress: params.progress ?? "", checklist: params.checklist ?? [], status: params.status, ownerSessionId: sessionId, createdInSessionId: sessionId });
				return { content: [{ type: "text" as const, text: JSON.stringify(serializeItem(todo), null, 2) }], details: { action: "create", id: displayId(todo) } };
			}
			if (!params.id) return { content: [{ type: "text" as const, text: "Error: Todo ID is required" }], details: { error: "id required" } };
			const todo = sessionTodo(ctx.cwd, params.id, sessionId);
			if (!todo) return { content: [{ type: "text" as const, text: `Todo not found in this session: TODO-${normalizeWorkItemId(params.id)}` }], details: { error: "not found" } };
			if (params.action === "get") return { content: [{ type: "text" as const, text: JSON.stringify(serializeItem(todo), null, 2) }], details: { action: "get", id: displayId(todo) } };
			return withFileMutationQueue(workItemPath(ctx.cwd, todo.id), async () => {
				if (params.action === "defer") {
					const result = deferTodo(ctx.cwd, todo.id, sessionId);
					return result ? { content: [{ type: "text" as const, text: `Deferred to Ideas: ${result.idea.title}` }], details: { action: "defer", id: displayId(result.idea) } } : { content: [{ type: "text" as const, text: `Could not defer ${displayId(todo)}` }], details: { error: "defer failed" } };
				}
				let result;
				const hasStructuredUpdate = params.title !== undefined || params.intent !== undefined || params.progress !== undefined || params.checklist !== undefined;
				if (params.action === "update") {
					result = updateWorkItem(ctx.cwd, todo.id, { title: params.title, intent: params.intent, progress: params.progress, checklist: params.checklist });
					if (result && params.status !== undefined) result = setTodoStatus(ctx.cwd, todo.id, params.status);
				} else if (params.action === "delete") result = deleteWorkItem(ctx.cwd, todo.id);
				else {
					if (hasStructuredUpdate) updateWorkItem(ctx.cwd, todo.id, { title: params.title, intent: params.intent, progress: params.progress, checklist: params.checklist });
					if (params.action === "start") result = startTodo(ctx.cwd, todo.id);
					else if (params.action === "complete") result = completeTodo(ctx.cwd, todo.id);
					else result = reopenTodo(ctx.cwd, todo.id);
				}
				return result ? { content: [{ type: "text" as const, text: JSON.stringify(serializeItem(result), null, 2) }], details: { action: params.action, id: displayId(result) } } : { content: [{ type: "text" as const, text: `Could not ${params.action} ${displayId(todo)}` }], details: { error: `${params.action} failed` } };
			});
		},
	});

	pi.registerTool({
		name: "idea",
		label: "Idea",
		description: "Manage project-wide possibilities, follow-ups, and future commitments that are not active in the current Pi session",
		promptSnippet: "Capture project work that should be retained for later rather than activated now",
		promptGuidelines: ["Promoting an Idea preserves its identity and assigns it to the current session."],
		parameters: Type.Object({
			action: StringEnum(["create", "list", "update", "delete", "promote"] as const),
			id: Type.Optional(Type.String({ description: "Idea ID (IDEA-<hex> or raw ID)" })),
			title: Type.Optional(Type.String({ description: "Short independently understandable Idea title" })),
			intent: Type.Optional(Type.String({ description: "Concise possibility and why it may matter" })),
			checklist: Type.Optional(Type.Array(checklistItem, { description: "Optional questions or outcomes to revisit" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const ideas = listIdeas(ctx.cwd);
				return { content: [{ type: "text" as const, text: ideas.length ? JSON.stringify(ideas.map(serializeItem), null, 2) : "No ideas" }], details: { action: "list", count: ideas.length } };
			}
			if (params.action === "create") {
				const title = params.title?.trim();
				if (!title) return { content: [{ type: "text" as const, text: "Error: Idea title is required" }], details: { error: "title required" } };
				const idea = createIdea(ctx.cwd, { title, intent: params.intent?.trim() ?? "", checklist: params.checklist ?? [], createdInSessionId: ctx.sessionManager.getSessionId() });
				return { content: [{ type: "text" as const, text: `Captured Idea: ${idea.title}` }], details: { action: "create", id: displayId(idea) } };
			}
			if (!params.id) return { content: [{ type: "text" as const, text: "Error: Idea ID is required" }], details: { error: "id required" } };
			const item = getWorkItem(ctx.cwd, params.id);
			if (!item || item.kind !== "idea") return { content: [{ type: "text" as const, text: `Idea not found: ${params.id}` }], details: { error: "not found" } };
			if (params.action === "update") {
				const idea = updateWorkItem(ctx.cwd, item.id, { title: params.title, intent: params.intent?.trim(), checklist: params.checklist });
				return { content: [{ type: "text" as const, text: `Updated Idea: ${idea.title}` }], details: { action: "update", id: displayId(idea) } };
			}
			if (params.action === "promote") {
				const promoted = promoteIdea(ctx.cwd, item.id, ctx.sessionManager.getSessionId());
				return { content: [{ type: "text" as const, text: `Promoted Idea to Todo: ${promoted.todo.title}` }], details: { action: "promote", id: displayId(promoted.todo) } };
			}
			const idea = deleteIdea(ctx.cwd, item.id);
			return { content: [{ type: "text" as const, text: `Deleted Idea: ${idea.title}` }], details: { action: "delete", id: displayId(idea) } };
		},
	});

	pi.registerCommand("todo", {
		description: "Add a Todo to the current session",
		handler: async (args, ctx) => {
			let title = args.trim();
			if (!title) {
				const entered = await ctx.ui.input("Add Todo", "Todo title");
				if (entered === undefined || !entered.trim()) return;
				title = entered.trim();
			}
			const sessionId = ctx.sessionManager.getSessionId();
			createTodo(ctx.cwd, { title, ownerSessionId: sessionId, createdInSessionId: sessionId });
			ctx.ui.notify(`Added Todo: ${title}`, "info");
		},
	});

	pi.registerCommand("idea", {
		description: "Capture an Idea for later",
		handler: async (args, ctx) => {
			let title = args.trim();
			if (!title) {
				const entered = await ctx.ui.input("Capture Idea", "Idea title");
				if (entered === undefined || !entered.trim()) return;
				title = entered.trim();
			}
			createIdea(ctx.cwd, { title, createdInSessionId: ctx.sessionManager.getSessionId() });
			ctx.ui.notify(`Captured Idea: ${title}`, "info");
		},
	});
}
