import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import {
	completeTodo,
	createTodo,
	deleteWorkItem,
	getWorkItem,
	isCompleted,
	listTodos,
	migrateLegacyWorkItems,
	normalizeTodoStatus,
	normalizeWorkItemId,
	reopenTodo,
	setTodoStatus,
	startTodo,
	updateWorkItem,
	type ChecklistItem,
	type WorkItem,
} from "../herdr/todos/work-item-store.js";
import { WorkIdeas } from "../herdr/todos/work-ideas.js";
import { workDisplayId, workAge, type RemoteWorkItem } from "../herdr/todos/work-client.js";

const ChecklistLeafSchema = Type.Object({
	text: Type.String({ description: "Concrete checklist outcome" }),
	done: Type.Optional(Type.Boolean()),
});

const ChecklistItemSchema = Type.Object({
	text: Type.String({ description: "Concrete checklist outcome or group" }),
	done: Type.Optional(Type.Boolean()),
	items: Type.Optional(Type.Array(ChecklistLeafSchema, { description: "Optional nested checklist outcomes" })),
});

const TodoActionSchema = StringEnum(["list", "list-all", "get", "create", "update", "delete", "start", "complete", "reopen", "defer"] as const);
const TodoStatusSchema = StringEnum(["ready", "in_progress", "done"] as const, {
	description: "Todo status; prefer start, complete, and reopen actions for transitions",
});
const TodoParameterProperties = {
	action: TodoActionSchema,
	sync_work: Type.Optional(Type.Boolean({ description: "Linked Todos on complete: true also marks the Work item done (only with user approval), false skips it, omit to ask." })),
	id: Type.Optional(Type.String({ description: "Todo ID (TODO-<hex> or raw ID)" })),
	title: Type.Optional(Type.String({ description: "Short independently understandable Todo title" })),
	intent: Type.Optional(Type.String({ description: "Concise desired outcome and why it matters" })),
	progress: Type.Optional(Type.String({ description: "Concise current progress or next constraint" })),
	checklist: Type.Optional(Type.Array(ChecklistItemSchema, { description: "Outcome-oriented checklist, optionally nested one level" })),
};
const TodoParametersSchema = Type.Object({ ...TodoParameterProperties, status: Type.Optional(TodoStatusSchema) });
const TodoPreparationSchema = Type.Object({ ...TodoParameterProperties, status: Type.Optional(Type.String()) });

type SerializedWorkItem = {
	id: string;
	kind: WorkItem["kind"];
	title: string;
	intent?: string;
	progress?: string;
	checklist?: ChecklistItem[];
	status?: string;
	owner_session_id?: string;
	created_in_session_id?: string;
	created_at: string;
	updated_at: string;
	work_id?: string;
	description?: string;
	state?: string;
	source?: string;
	age?: string;
};
type ResultMetadata = { stale?: boolean; error?: string; queued?: boolean; blocked?: boolean; key?: string; offer?: string; outbox?: { pending: number; blocked: number; path: string } };

const WorkItemOutputSchema = Type.Object({
	action: Type.String(),
	items: Type.Array(Type.Object({
		id: Type.String(), kind: StringEnum(["todo", "idea"] as const), title: Type.String(),
		intent: Type.Optional(Type.String()), progress: Type.Optional(Type.String()),
		checklist: Type.Optional(Type.Array(ChecklistItemSchema)),
		status: Type.Optional(Type.String()), owner_session_id: Type.Optional(Type.String()),
		created_in_session_id: Type.Optional(Type.String()),
		created_at: Type.String(), updated_at: Type.String(),
		work_id: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
		state: Type.Optional(Type.String()), source: Type.Optional(Type.String()), age: Type.Optional(Type.String()),
	})),
	stale: Type.Optional(Type.Boolean()), error: Type.Optional(Type.String()),
	queued: Type.Optional(Type.Boolean()), blocked: Type.Optional(Type.Boolean()), key: Type.Optional(Type.String()),
	offer: Type.Optional(Type.String()),
	outbox: Type.Optional(Type.Object({ pending: Type.Number(), blocked: Type.Number(), path: Type.String() })),
});

function workItemResult(action: string, items: Array<WorkItem | RemoteWorkItem>, metadata: ResultMetadata = {}) {
	const selected: ResultMetadata = { stale: metadata.stale, error: metadata.error, queued: metadata.queued, blocked: metadata.blocked, key: metadata.key, offer: metadata.offer, outbox: metadata.outbox };
	const structuredContent = { action, items: items.map((item) => "kind" in item ? serializeItem(item) : {
		id: workDisplayId(item), kind: "idea", title: item.title, work_id: item.id,
		description: item.description, state: item.state, source: item.source, age: workAge(item.created_at),
		created_at: item.created_at, updated_at: item.updated_at,
	}), ...selected };
	return {
		content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
		details: { action, count: items.length },
		structuredContent,
	};
}

function displayId(item: { id: string; kind: string }): string {
	return `${item.kind === "idea" ? "IDEA" : "TODO"}-${normalizeWorkItemId(item.id)}`;
}

function serializeItem(item: WorkItem): SerializedWorkItem {
	const serialized: SerializedWorkItem = {
		id: displayId(item),
		kind: item.kind,
		title: item.title,
		intent: item.intent || undefined,
		progress: item.progress || undefined,
		checklist: item.checklist.length > 0 ? item.checklist : undefined,
		created_in_session_id: item.createdInSessionId,
		work_id: item.workId,
		created_at: item.createdAt,
		updated_at: item.updatedAt,
	};
	if (item.kind === "todo") {
		serialized.status = item.status;
		serialized.owner_session_id = item.ownerSessionId;
	}
	return serialized;
}

function sessionTodo(cwd: string, id: string, sessionId: string) {
	const item = getWorkItem(cwd, id);
	return item?.kind === "todo" && item.ownerSessionId === sessionId ? item : undefined;
}

export function registerTodosFeature(pi: ExtensionAPI, ideas = new WorkIdeas()): void {
	pi.on("session_start", (_event, ctx) => {
		const migrated = migrateLegacyWorkItems(ctx.cwd);
		if (migrated.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`pi-adam: migrated ${migrated.length} legacy Todo${migrated.length === 1 ? "" : "s"}`, "info");
		}

	});

	pi.registerTool({
		name: "todo",
		outputSchema: WorkItemOutputSchema,
		label: "Todo",
		description: "Manage this session's Todos: list (active), list-all (incl. done), get, create, update, delete, start, complete, reopen, defer (send to Work as an Idea for later).",
		promptSnippet: "Show Adam the agreed work for the current task and how far through it you are",
		promptGuidelines: [
			"Todos are Adam's view of the current task: what was agreed and where you're up to. Write them so he can tell at a glance what's done, what's in progress, and why something is taking longer than expected.",
			"Use a handful of meaningful steps Adam would recognise, not micro-steps. Skip them for quick one-step requests.",
			"Keep Todo status current as you go, and put blockers or surprises in progress.",
		],
		parameters: TodoParametersSchema,
		prepareArguments(args) {
			const input = Parse(TodoPreparationSchema, args);
			return {
				...input,
				status: input.status === undefined ? undefined : normalizeTodoStatus(input.status),
			};
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.action === "list" || params.action === "list-all") {
				const todos = listTodos(ctx.cwd, { sessionId }).filter((todo) => params.action === "list-all" || !isCompleted(todo));
				return workItemResult(params.action, todos);
			}
			if (params.action === "create") {
				const title = params.title?.trim();
				if (!title) throw new Error("Error: Todo title is required");
				const todo = createTodo(ctx.cwd, { title, intent: params.intent ?? "", progress: params.progress ?? "", checklist: params.checklist ?? [], status: params.status, ownerSessionId: sessionId, createdInSessionId: sessionId });
				return workItemResult(params.action, [todo]);
			}
			if (!params.id) throw new Error("Error: Todo ID is required");
			const todo = sessionTodo(ctx.cwd, params.id, sessionId);
			if (!todo) throw new Error(`Todo not found in this session: TODO-${normalizeWorkItemId(params.id)}`);
			if (params.action === "get") return workItemResult(params.action, [todo]);
			return withFileMutationQueue(todo.path, async () => {
				if (params.action === "defer") {
					const result = await ideas.defer(ctx.cwd, todo.id, sessionId);
					return workItemResult("defer", result.item ? [result.item] : [todo], result);
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
				if (!result) throw new Error(`Could not ${params.action} ${displayId(todo)}`);
				const metadata: ResultMetadata = {};
				if (result.kind === "todo" && result.status === "done" && result.workId && params.action !== "delete") {
					const approved = params.sync_work ?? (ctx.hasUI ? await ctx.ui.confirm("Complete Work item?", `Also mark ${result.workId} done in Work?`) : false);
					if (approved) {
						try { await ideas.complete(result); }
						catch { metadata.error = "Todo completed locally; Work could not be updated. Retry complete with sync_work: true after resolving the connection/link."; }
					} else if (params.sync_work === undefined && !ctx.hasUI) metadata.offer = "Todo completed locally. Ask the user whether to mark its Work item done; if approved, repeat complete with sync_work: true.";
				}
				return workItemResult(params.action, [result], metadata);
			});
		},
	});

	pi.registerTool({
		name: "idea",
		outputSchema: WorkItemOutputSchema,
		label: "Idea",
		description: "Manage this project's Ideas in Work (work.haume.nz): inbox/open items, including feedback. promote turns one into a session Todo; delete drops it. Offline, list returns stale:true and create returns queued:true with a UUID key, not a Work ID. Use the work-triage skill for bulk triage.",
		promptSnippet: "Park side quests to look at later without derailing the current work",
		promptGuidelines: [
			"When a worthwhile tangent comes up that isn't part of the current task, capture it as an idea instead of pursuing it or letting it drop, and tell Adam you did.",
			"Write Idea titles and intent so they make sense weeks later without this conversation: what to investigate and why it came up.",
		],
		parameters: Type.Object({
			action: StringEnum(["create", "list", "update", "delete", "promote"] as const),
			id: Type.Optional(Type.String({ description: "Work ID (work_<24 hex>) or unambiguous IDEA-<last 6 hex> from a fresh list" })),
			title: Type.Optional(Type.String({ description: "Short independently understandable Idea title" })),
			intent: Type.Optional(Type.String({ description: "What to investigate and why it came up" })),
			checklist: Type.Optional(Type.Array(ChecklistItemSchema, { description: "Optional questions or outcomes to revisit" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const list = await ideas.client.list(ctx.cwd);
				return workItemResult(params.action, list.items, { stale: list.stale, error: list.error, outbox: list.outbox });
			}
			if (params.action === "create") {
				const title = params.title?.trim();
				if (!title) throw new Error("Error: Idea title is required");
				const capture = await ideas.client.create(ctx.cwd, { title, intent: params.intent, checklist: params.checklist, source: "agent" });
				return workItemResult(params.action, capture.item ? [capture.item] : [], capture);
			}
			if (!params.id) throw new Error("Error: Idea ID is required");
			if (params.action === "update") return workItemResult(params.action, [await ideas.update(ctx.cwd, params.id, params)]);
			if (params.action === "promote") return workItemResult(params.action, [await ideas.promote(ctx.cwd, params.id, ctx.sessionManager.getSessionId())]);
			return workItemResult(params.action, [await ideas.drop(ctx.cwd, params.id)]);
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

	pi.registerCommand("work-outbox", {
		description: "Retry Work captures (use 'retry' to also retry blocked captures after fixing credentials/validation)",
		handler: async (args, ctx) => {
			try {
				await ideas.client.flush(args.trim() === "retry");
				const result = await ideas.client.list(ctx.cwd);
				ctx.ui.notify(result.outbox ? `Work outbox: ${result.outbox.pending} pending, ${result.outbox.blocked} blocked. ${result.outbox.path}` : result.error ?? "Work outbox checked", result.error || result.outbox?.blocked ? "warning" : "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Work outbox failed", "error"); }
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
			try {
				const capture = await ideas.client.create(ctx.cwd, { title, source: "idea" });
				ctx.ui.notify(capture.item ? `Captured ${workDisplayId(capture.item)} (${workAge(capture.item.created_at)}): ${title}` : `Idea saved in Work outbox${capture.blocked ? " (blocked)" : ""}: ${capture.error}`, capture.item ? "info" : "warning");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Work capture failed", "error"); }
		},
	});
}
