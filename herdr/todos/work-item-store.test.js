import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	checklistProgress,
	clearCompleted,
	completeTodo,
	createIdea,
	createTodo,
	cycleTodo,
	deferTodo,
	getWorkItem,
	listIdeas,
	listTodos,
	migrateLegacyWorkItems,
	promoteIdea,
	reopenTodo,
	startTodo,
	toggleWorkItemKind,
	updateWorkItem,
} from "./work-item-store.js";

function fixture(prefix) {
	const cwd = mkdtempSync(join(tmpdir(), prefix));
	return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("Todo status transitions use ready, in progress, and done", () => {
	const f = fixture("pi-adam-work-status-");
	try {
		const todo = createTodo(f.cwd, { title: "Outcome", ownerSessionId: "owner", createdInSessionId: "origin" });
		assert.equal(todo.status, "ready");
		assert.equal(startTodo(f.cwd, todo.id).status, "in_progress");
		assert.equal(completeTodo(f.cwd, todo.id).status, "done");
		assert.equal(reopenTodo(f.cwd, todo.id).status, "ready");
		assert.equal(cycleTodo(getWorkItem(f.cwd, todo.id)).status, "in_progress");
		assert.equal(getWorkItem(f.cwd, todo.id).ownerSessionId, "owner");
		assert.equal(getWorkItem(f.cwd, todo.id).createdInSessionId, "origin");
	} finally { f.cleanup(); }
});

test("structured intent, progress, and nested checklists round-trip as JSON", () => {
	const f = fixture("pi-adam-work-json-");
	try {
		const todo = createTodo(f.cwd, {
			title: "Structured",
			intent: "Desired outcome",
			progress: "Parser complete",
			checklist: [
				{ text: "Top-level", done: true },
				{ text: "Group", items: [{ text: "Nested done", done: true }, { text: "Nested ready", done: false }] },
			],
			ownerSessionId: "owner",
			createdInSessionId: "origin",
		});
		assert.deepEqual(checklistProgress(todo.checklist), { done: 2, total: 3 });
		const raw = JSON.parse(readFileSync(todo.path, "utf8"));
		assert.equal(raw.schema_version, 1);
		assert.equal(raw.intent, "Desired outcome");
		assert.ok(todo.path.endsWith(".json"));
		const updated = updateWorkItem(f.cwd, todo.id, { progress: "Verified", checklist: [{ text: "Complete", done: true }] });
		assert.equal(updated.progress, "Verified");
		assert.deepEqual(updated.checklist, [{ text: "Complete", done: true }]);
	} finally { f.cleanup(); }
});

test("promotion and deferral preserve identity, provenance, and structured context", () => {
	const f = fixture("pi-adam-work-kind-");
	try {
		const idea = createIdea(f.cwd, { title: "Later", intent: "Context", checklist: [{ text: "Question", done: false }], createdInSessionId: "origin" });
		const promoted = promoteIdea(f.cwd, idea.id, "owner");
		assert.equal(promoted.todo.id, idea.id);
		assert.equal(promoted.todo.status, "ready");
		assert.equal(promoted.todo.ownerSessionId, "owner");
		assert.equal(promoted.todo.createdInSessionId, "origin");
		const deferred = deferTodo(f.cwd, idea.id, "owner");
		assert.equal(deferred.idea.id, idea.id);
		assert.equal(deferred.idea.kind, "idea");
		assert.equal(deferred.idea.ownerSessionId, undefined);
		assert.equal(deferred.idea.intent, "Context");
		assert.deepEqual(deferred.idea.checklist, [{ text: "Question", done: false }]);
	} finally { f.cleanup(); }
});

test("kind toggling follows the Work Item between Ideas and ready Todos", () => {
	const f = fixture("pi-adam-work-toggle-kind-");
	try {
		const todo = createTodo(f.cwd, { title: "Toggle", status: "done", ownerSessionId: "owner", createdInSessionId: "origin" });
		const idea = toggleWorkItemKind(f.cwd, todo.id, "owner");
		assert.equal(idea.kind, "idea");
		assert.equal(idea.status, undefined);
		assert.equal(idea.ownerSessionId, undefined);
		const restored = toggleWorkItemKind(f.cwd, todo.id, "new-owner");
		assert.equal(restored.kind, "todo");
		assert.equal(restored.status, "ready");
		assert.equal(restored.ownerSessionId, "new-owner");
	} finally { f.cleanup(); }
});

test("clear removes done Todos only for the requested owner", () => {
	const f = fixture("pi-adam-work-clear-");
	try {
		createTodo(f.cwd, { title: "A", status: "done", ownerSessionId: "one", createdInSessionId: "one" });
		createTodo(f.cwd, { title: "B", status: "ready", ownerSessionId: "one", createdInSessionId: "one" });
		createTodo(f.cwd, { title: "C", status: "done", ownerSessionId: "two", createdInSessionId: "two" });
		assert.equal(clearCompleted(f.cwd, { sessionId: "one" }).length, 1);
		assert.deepEqual(listTodos(f.cwd).map((item) => item.title).sort(), ["B", "C"]);
	} finally { f.cleanup(); }
});

test("Markdown Work Items and older Todo/Idea files migrate to structured JSON", () => {
	const f = fixture("pi-adam-work-migrate-");
	try {
		const workItems = join(f.cwd, ".pi", "work-items");
		const todos = join(f.cwd, ".pi", "todos");
		const ideas = join(f.cwd, ".pi", "ideas");
		mkdirSync(workItems, { recursive: true });
		mkdirSync(todos, { recursive: true });
		mkdirSync(ideas, { recursive: true });
		writeFileSync(join(workItems, "done.md"), `${JSON.stringify({ id: "done", kind: "todo", title: "Done", status: "closed", owner_session_id: "owner", created_in_session_id: "origin", created_at: "0" }, null, 2)}\n\nFinished successfully.`);
		writeFileSync(join(todos, "active.md"), `${JSON.stringify({ id: "active", title: "Active", status: "open", tags: ["session:owner"], assigned_to_session: "owner", created_at: "1" }, null, 2)}\n\nDesired result\n\n- [x] First\n- [ ] Second`);
		writeFileSync(join(todos, "project.md"), `${JSON.stringify({ id: "project", title: "Project", status: "open", tags: ["project"], created_at: "2" }, null, 2)}\n\nFuture possibility`);
		writeFileSync(join(ideas, "idea.md"), `${JSON.stringify({ id: "idea", title: "Idea", origin_session_id: "origin", created_at: "3", updated_at: "4" }, null, 2)}\n\nIdea context`);
		assert.equal(migrateLegacyWorkItems(f.cwd).length, 4);
		assert.equal(getWorkItem(f.cwd, "done").status, "done");
		assert.equal(getWorkItem(f.cwd, "done").progress, "Finished successfully.");
		const active = getWorkItem(f.cwd, "active");
		assert.equal(active.status, "in_progress");
		assert.equal(active.intent, "Desired result");
		assert.deepEqual(checklistProgress(active.checklist), { done: 1, total: 2 });
		assert.deepEqual(listIdeas(f.cwd).map((item) => item.id), ["project", "idea"]);
		assert.equal(getWorkItem(f.cwd, "idea").createdInSessionId, "origin");
		assert.equal(readdirSync(workItems).filter((name) => name.endsWith(".md")).length, 0);
		assert.equal(readdirSync(todos).length, 0);
		assert.equal(readdirSync(ideas).length, 0);
		assert.equal(migrateLegacyWorkItems(f.cwd).length, 0);
	} finally { f.cleanup(); }
});
