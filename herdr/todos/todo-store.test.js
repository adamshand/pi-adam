import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendTodo, claimTodo, clearCompleted, cycleTodo, listTodos, readTodo, releaseTodo, sessionTag, todoState, updateTodo } from "./todo-store.js";

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

test("lists only Todos owned by the requested session", () => {
	const f = fixture();
	try {
		f.add("a", { tags: [sessionTag("s1")] });
		f.add("b", { tags: [sessionTag("s2")] });
		f.add("legacy");
		assert.deepEqual(listTodos(f.cwd, { sessionId: "s1" }).map((todo) => todo.id), ["a"]);
		assert.deepEqual(listTodos(f.cwd).map((todo) => todo.id), ["a", "b", "legacy"]);
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

test("updates, appends, claims, and releases a Todo", () => {
	const f = fixture();
	try {
		f.add("a", { tags: [sessionTag("s1")] });
		assert.equal(updateTodo(f.cwd, "a", { title: "Changed" }).title, "Changed");
		assert.match(appendTodo(f.cwd, "a", "More context").body, /More context/);
		assert.equal(claimTodo(f.cwd, "a", "s1").assignedToSession, "s1");
		assert.deepEqual(claimTodo(f.cwd, "a", "s2"), { conflict: "s1" });
		assert.equal(releaseTodo(f.cwd, "a", "s1").assignedToSession, undefined);
	} finally {
		f.cleanup();
	}
});

test("clears completed Todos only for the requested session", () => {
	const f = fixture();
	try {
		f.add("session-done", { status: "closed", tags: [sessionTag("s1")] });
		f.add("other-done", { status: "closed", tags: [sessionTag("s2")] });
		f.add("session-open", { tags: [sessionTag("s1")] });
		assert.deepEqual(clearCompleted(f.cwd, { sessionId: "s1" }).map((todo) => todo.id), ["session-done"]);
		assert.deepEqual(listTodos(f.cwd).map((todo) => todo.id), ["other-done", "session-open"]);
	} finally {
		f.cleanup();
	}
});
