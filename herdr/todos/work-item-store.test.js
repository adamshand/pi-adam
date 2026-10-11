import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	checklistProgress,
	clearCompleted,
	completeTodo,
	createTodo,
	createWorkItem,
	cycleTodo,
	getWorkItem,
	listWorkItems,
	listTodos,
	migrateLegacyWorkItems,
	reopenTodo,
	startTodo,
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
		assert.equal(raw.schema_version, 2);
		assert.equal(raw.session_id, "owner");
		assert.equal(raw.todos[0].intent, "Desired outcome");
		assert.ok(todo.path.endsWith(".json"));
		const updated = updateWorkItem(f.cwd, todo.id, { progress: "Verified", checklist: [{ text: "Complete", done: true }] });
		assert.equal(updated.progress, "Verified");
		assert.deepEqual(updated.checklist, [{ text: "Complete", done: true }]);
	} finally { f.cleanup(); }
});

test("malformed persisted Work Items are rejected at the storage boundary", () => {
	const f = fixture("pi-adam-work-invalid-");
	try {
		const directory = join(f.cwd, ".pi", "work-items");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "bad.json"), JSON.stringify({ id: "bad", checklist: "not-an-array" }));
		assert.equal(getWorkItem(f.cwd, "bad"), undefined);
	} finally { f.cleanup(); }
});

test("Work links survive local Todo updates; new local Ideas are rejected", () => {
 const f = fixture("pi-adam-work-links-");
 try {
  const workId = "work_0123456789abcdef01234567";
  const todo = createTodo(f.cwd, { title: "Linked", workId, workUrl: "https://work.haume.nz", workCaptureKey: "capture" });
  completeTodo(f.cwd, todo.id);
  assert.equal(getWorkItem(f.cwd, todo.id).workId, workId);
  assert.equal(getWorkItem(f.cwd, todo.id).workCaptureKey, "capture");
  assert.throws(() => createWorkItem(f.cwd, { title: "Legacy", kind: "idea" }), /Ideas live in Work/);
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
		assert.equal(migrateLegacyWorkItems(f.cwd).length, 2);
		assert.equal(getWorkItem(f.cwd, "done").status, "done");
		assert.equal(getWorkItem(f.cwd, "done").progress, "Finished successfully.");
		const active = getWorkItem(f.cwd, "active");
		assert.equal(active.status, "in_progress");
		assert.equal(active.intent, "Desired result");
		assert.deepEqual(checklistProgress(active.checklist), { done: 1, total: 2 });
		assert.ok(listWorkItems(f.cwd).every((item) => item.kind === "todo"));
		assert.match(readFileSync(join(ideas, "idea.md"), "utf8"), /Idea context/);
		assert.equal(readdirSync(workItems).filter((name) => name.endsWith(".md")).length, 0);
		assert.deepEqual(readdirSync(todos), ["owner.json", "project.md"]);
		assert.deepEqual(readdirSync(ideas), ["idea.md"]);
		assert.equal(migrateLegacyWorkItems(f.cwd).length, 0);
	} finally { f.cleanup(); }
});
