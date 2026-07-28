import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearCompleted, cycleTodo, listTodos, readTodo, sessionTag, todoState } from "./todo-store.js";

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-todos-"));
	const directory = join(cwd, ".pi", "todos");
	mkdirSync(directory, { recursive: true });
	const add = (id, metadata = {}) => {
		const path = join(directory, `${id}.md`);
		writeFileSync(path, `${JSON.stringify({ id, title: id, status: "open", tags: [], created_at: id, ...metadata }, null, 2)}\n\nBody for ${id}\n`);
		return path;
	};
	return { cwd, add, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("filters session todos without affecting project scope", () => {
	const f = fixture();
	try {
		f.add("a", { tags: [sessionTag("s1")] });
		f.add("b", { tags: [sessionTag("s2")] });
		f.add("c");
		assert.deepEqual(listTodos(f.cwd, { scope: "session", sessionId: "s1" }).map((todo) => todo.id), ["a"]);
		assert.deepEqual(listTodos(f.cwd, { scope: "project", sessionId: "s1" }).map((todo) => todo.id), ["a", "b", "c"]);
	} finally {
		f.cleanup();
	}
});

test("cycles outstanding to in progress to done and back", () => {
	const f = fixture();
	try {
		const path = f.add("a", { tags: [sessionTag("s1")] });
		let todo = readTodo(path);
		assert.equal(todoState(todo), "outstanding");
		todo = cycleTodo(todo, "s1");
		assert.equal(todoState(todo), "in_progress");
		assert.equal(todo.assignedToSession, "s1");
		todo = cycleTodo(todo, "s1");
		assert.equal(todoState(todo), "done");
		todo = cycleTodo(todo, "s1");
		assert.equal(todoState(todo), "outstanding");
		assert.match(readFileSync(path, "utf8"), /Body for a/);
	} finally {
		f.cleanup();
	}
});

test("clears only completed todos in the selected scope", () => {
	const f = fixture();
	try {
		f.add("session-done", { status: "closed", tags: [sessionTag("s1")] });
		f.add("other-done", { status: "closed", tags: [sessionTag("s2")] });
		f.add("session-open", { tags: [sessionTag("s1")] });
		assert.deepEqual(clearCompleted(f.cwd, { scope: "session", sessionId: "s1" }).map((todo) => todo.id), ["session-done"]);
		assert.deepEqual(listTodos(f.cwd, { scope: "project" }).map((todo) => todo.id), ["other-done", "session-open"]);
		assert.deepEqual(clearCompleted(f.cwd, { scope: "project" }).map((todo) => todo.id), ["other-done"]);
		assert.deepEqual(listTodos(f.cwd, { scope: "project" }).map((todo) => todo.id), ["session-open"]);
	} finally {
		f.cleanup();
	}
});
