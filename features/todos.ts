import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createIdea, deferTodo, deleteIdea, listIdeas, migrateLegacyProjectTodos, promoteIdea, updateIdea } from "../herdr/todos/idea-store.js";
import { appendTodo, claimTodo, createTodo, deleteTodo, getTodo, isCompleted, listTodos, normalizeTodoId, releaseTodo, sessionTag, todoPath, updateTodo } from "../herdr/todos/todo-store.js";

const TODO_ID_PREFIX = "TODO-";
const SESSION_TAG_PREFIX = "session:";

function displayTodoId(id: string): string {
	return `${TODO_ID_PREFIX}${normalizeTodoId(id)}`;
}

function visibleTags(tags: unknown, sessionId: string): string[] {
	const values = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
	return [...values.filter((tag) => tag !== "project" && !tag.startsWith(SESSION_TAG_PREFIX)), sessionTag(sessionId)];
}

function serializeTodo(todo: any) {
	return {
		id: displayTodoId(todo.id),
		title: todo.title,
		tags: todo.tags.filter((tag: string) => !tag.startsWith(SESSION_TAG_PREFIX)),
		status: todo.status,
		created_at: todo.createdAt,
		assigned_to_session: todo.assignedToSession,
		body: todo.body,
	};
}

function sessionTodo(cwd: string, id: string, sessionId: string) {
	const todo = getTodo(cwd, id);
	return todo?.tags.includes(sessionTag(sessionId)) ? todo : undefined;
}

export function registerTodosFeature(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nTodo discipline:\n- Treat todos as the active commitments of this Pi session, not a transcript of every mechanical step.\n- Use the idea tool for project-wide possibilities, follow-ups, or future commitments that are not active in this session.\n- For non-trivial committed work, normally maintain 3–7 outcome-level todos rather than one umbrella ticket or many tiny implementation tickets.\n- Give each todo or idea an independently understandable title. Keep its body concise: why it matters, key constraints, acceptance criteria, and only tightly related checklist steps.\n- Promote an idea when accepting it into the current session; defer an unfinished todo when it should return to Ideas.\n- Before settling, reconcile todos and ideas against the conversation so no promised outcome or explicitly captured future possibility is forgotten and statuses remain accurate.`,
	}));

	pi.on("session_start", (_event, ctx) => {
		const migrated = migrateLegacyProjectTodos(ctx.cwd);
		if (migrated.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`pi-adam: moved ${migrated.length} legacy project todo${migrated.length === 1 ? "" : "s"} to Ideas`, "info");
		}
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage Todos owned by the current Pi session. Actions: list active Todos, list-all including completed Todos, get, create, update, append, delete, claim, release, and defer a Todo back to project Ideas.",
		promptSnippet: "Manage active commitments owned by the current Pi session",
		promptGuidelines: ["Use todo for active commitments in the current session; use idea for work retained for later."],
		parameters: Type.Object({
			action: StringEnum(["list", "list-all", "get", "create", "update", "append", "delete", "claim", "release", "defer"] as const),
			id: Type.Optional(Type.String({ description: "Todo ID (TODO-<hex> or raw ID)" })),
			title: Type.Optional(Type.String({ description: "Short independently understandable Todo title" })),
			status: Type.Optional(Type.String({ description: "Todo status" })),
			tags: Type.Optional(Type.Array(Type.String({ description: "Non-scope Todo tag" }))),
			body: Type.Optional(Type.String({ description: "Concise context and acceptance criteria; update replaces and append adds" })),
			force: Type.Optional(Type.Boolean({ description: "Override another assignment" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.action === "list" || params.action === "list-all") {
				const todos = listTodos(ctx.cwd, { sessionId }).filter((todo) => params.action === "list-all" || !isCompleted(todo));
				return {
					content: [{ type: "text" as const, text: todos.length ? JSON.stringify(todos.map(serializeTodo), null, 2) : "No todos" }],
					details: { action: params.action, count: todos.length },
				};
			}
			if (params.action === "create") {
				const title = params.title?.trim();
				if (!title) return { content: [{ type: "text" as const, text: "Error: Todo title is required" }], details: { error: "title required" } };
				const todo = createTodo(ctx.cwd, {
					title,
					body: params.body ?? "",
					status: params.status,
					tags: visibleTags(params.tags, sessionId),
				});
				return { content: [{ type: "text" as const, text: JSON.stringify(serializeTodo(todo), null, 2) }], details: { action: "create", id: displayTodoId(todo.id) } };
			}
			if (!params.id) return { content: [{ type: "text" as const, text: "Error: Todo ID is required" }], details: { error: "id required" } };
			const todo = sessionTodo(ctx.cwd, params.id, sessionId);
			if (!todo) return { content: [{ type: "text" as const, text: `Todo not found in this session: ${displayTodoId(params.id)}` }], details: { error: "not found" } };
			if (params.action === "get") {
				return { content: [{ type: "text" as const, text: JSON.stringify(serializeTodo(todo), null, 2) }], details: { action: "get", id: displayTodoId(todo.id) } };
			}
			return withFileMutationQueue(todoPath(ctx.cwd, todo.id), async () => {
				let result: any;
				if (params.action === "update") {
					result = updateTodo(ctx.cwd, todo.id, {
						title: params.title,
						status: params.status,
						body: params.body,
						tags: params.tags === undefined ? undefined : visibleTags(params.tags, sessionId),
					});
				} else if (params.action === "append") {
					result = appendTodo(ctx.cwd, todo.id, params.body);
				} else if (params.action === "delete") {
					result = deleteTodo(ctx.cwd, todo.id);
				} else if (params.action === "claim") {
					result = claimTodo(ctx.cwd, todo.id, sessionId, Boolean(params.force));
				} else if (params.action === "release") {
					result = releaseTodo(ctx.cwd, todo.id, sessionId, Boolean(params.force));
				} else {
					const deferred = deferTodo(ctx.cwd, todo.id, sessionId);
					return deferred
						? { content: [{ type: "text" as const, text: `Deferred to Ideas: ${deferred.idea.title}` }], details: { action: "defer", ideaId: deferred.idea.id } }
						: { content: [{ type: "text" as const, text: `Could not defer ${displayTodoId(todo.id)}` }], details: { error: "defer failed" } };
				}
				if (result && "conflict" in result) {
					return { content: [{ type: "text" as const, text: `Todo is assigned to session ${result.conflict}` }], details: { error: "assignment conflict" } };
				}
				return result
					? { content: [{ type: "text" as const, text: JSON.stringify(serializeTodo(result), null, 2) }], details: { action: params.action, id: displayTodoId(result.id) } }
					: { content: [{ type: "text" as const, text: `Could not ${params.action} ${displayTodoId(todo.id)}` }], details: { error: `${params.action} failed` } };
			});
		},
	});

	pi.registerTool({
		name: "idea",
		label: "Idea",
		description: "Manage project-wide possibilities, follow-ups, and future commitments that are not active in the current Pi session",
		promptSnippet: "Capture project work that should be retained for later rather than activated now",
		promptGuidelines: ["Use idea for work retained for later; promote it only when accepting it into the current session."],
		parameters: Type.Object({
			action: StringEnum(["create", "list", "update", "delete", "promote"] as const),
			id: Type.Optional(Type.String({ description: "Idea ID for update, delete, or promote" })),
			title: Type.Optional(Type.String({ description: "Short independently understandable Idea title" })),
			body: Type.Optional(Type.String({ description: "Concise context explaining why the Idea may matter" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const ideas = listIdeas(ctx.cwd);
				return { content: [{ type: "text" as const, text: ideas.length ? ideas.map((idea) => `${idea.id}: ${idea.title}`).join("\n") : "No ideas" }], details: { action: "list", count: ideas.length } };
			}
			if (params.action === "create") {
				const title = params.title?.trim();
				if (!title) return { content: [{ type: "text" as const, text: "Error: Idea title is required" }], details: { error: "title required" } };
				const idea = createIdea(ctx.cwd, { title, body: params.body?.trim() ?? "", originSessionId: ctx.sessionManager.getSessionId(), origin: "agent" });
				return { content: [{ type: "text" as const, text: `Captured Idea: ${idea.title}` }], details: { action: "create", id: idea.id } };
			}
			if (!params.id) return { content: [{ type: "text" as const, text: "Error: Idea ID is required" }], details: { error: "id required" } };
			if (params.action === "update") {
				const idea = updateIdea(ctx.cwd, params.id, { title: params.title, body: params.body?.trim() });
				return idea ? { content: [{ type: "text" as const, text: `Updated Idea: ${idea.title}` }], details: { action: "update", id: idea.id } } : { content: [{ type: "text" as const, text: `Idea not found: ${params.id}` }], details: { error: "not found" } };
			}
			if (params.action === "promote") {
				const promoted = promoteIdea(ctx.cwd, params.id, ctx.sessionManager.getSessionId());
				return promoted ? { content: [{ type: "text" as const, text: `Promoted Idea to Todo: ${promoted.todo.title}` }], details: { action: "promote", id: displayTodoId(promoted.todo.id) } } : { content: [{ type: "text" as const, text: `Idea not found: ${params.id}` }], details: { error: "not found" } };
			}
			const idea = deleteIdea(ctx.cwd, params.id);
			return idea ? { content: [{ type: "text" as const, text: `Deleted Idea: ${idea.title}` }], details: { action: "delete", id: idea.id } } : { content: [{ type: "text" as const, text: `Idea not found: ${params.id}` }], details: { error: "not found" } };
		},
	});

	pi.registerCommand("todo", {
		description: "Add a Todo to the current session",
		handler: async (args, ctx) => {
			let title = args.trim();
			if (!title) {
				const entered = await ctx.ui.input("Add Todo", "Todo title");
				if (entered === undefined) return;
				title = entered.trim();
				if (!title) return;
			}
			createTodo(ctx.cwd, { title, tags: [sessionTag(ctx.sessionManager.getSessionId())] });
			ctx.ui.notify(`Added Todo: ${title}`, "info");
		},
	});

	pi.registerCommand("idea", {
		description: "Capture an Idea for later",
		handler: async (args, ctx) => {
			let title = args.trim();
			if (!title) {
				const entered = await ctx.ui.input("Capture Idea", "Idea title");
				if (entered === undefined) return;
				title = entered.trim();
				if (!title) return;
			}
			createIdea(ctx.cwd, { title, originSessionId: ctx.sessionManager.getSessionId(), origin: "user" });
			ctx.ui.notify(`Captured Idea: ${title}`, "info");
		},
	});
}
