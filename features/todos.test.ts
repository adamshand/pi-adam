import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIdea, deferTodo, listIdeas, migrateLegacyProjectTodos, promoteIdea } from "../herdr/todos/idea-store.js";
import { createTodo, listTodos, sessionTag } from "../herdr/todos/todo-store.js";

test("Ideas promote into session Todos and unfinished Todos defer back into Ideas", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-ledger-transitions-"));
	try {
		const idea = createIdea(cwd, { title: "Review later", body: "Keep context" });
		const promoted = promoteIdea(cwd, idea.id, "session-one");
		assert.equal(listIdeas(cwd).length, 0);
		assert.deepEqual(promoted.todo.tags, [sessionTag("session-one")]);
		const deferred = deferTodo(cwd, promoted.todo.id, "session-one");
		assert.equal(listTodos(cwd, { sessionId: "session-one" }).length, 0);
		assert.equal(deferred.idea.title, "Review later");
		assert.equal(deferred.idea.body.trim(), "Keep context");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("completed Todos cannot be deferred", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-ledger-completed-"));
	try {
		const todo = createTodo(cwd, { title: "Done", status: "closed", tags: [sessionTag("session-one")] });
		assert.equal(deferTodo(cwd, todo.id, "session-one"), undefined);
		assert.equal(listIdeas(cwd).length, 0);
		assert.equal(listTodos(cwd, { sessionId: "session-one" }).length, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("legacy open project or unscoped Todos migrate to Ideas", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-ledger-migrate-"));
	const directory = join(cwd, ".pi", "todos");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "project.md"), `${JSON.stringify({ id: "project", title: "Project follow-up", status: "open", tags: ["project"], created_at: "project" }, null, 2)}\n\nProject context\n`);
	writeFileSync(join(directory, "unscoped.md"), `${JSON.stringify({ id: "unscoped", title: "Unscoped follow-up", status: "open", tags: [], created_at: "unscoped" }, null, 2)}\n\n`);
	writeFileSync(join(directory, "session.md"), `${JSON.stringify({ id: "session", title: "Current Todo", status: "open", tags: [sessionTag("session-one")], created_at: "session" }, null, 2)}\n\n`);
	writeFileSync(join(directory, "closed.md"), `${JSON.stringify({ id: "closed", title: "Already done", status: "closed", tags: [], created_at: "closed" }, null, 2)}\n\n`);
	try {
		const migrated = migrateLegacyProjectTodos(cwd);
		assert.equal(migrated.length, 2);
		assert.deepEqual(listIdeas(cwd).map((idea) => idea.title).sort(), ["Project follow-up", "Unscoped follow-up"]);
		assert.deepEqual(listTodos(cwd).map((todo) => todo.id), ["closed", "session"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
