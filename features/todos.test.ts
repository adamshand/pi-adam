import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeTodo, createIdea, createTodo, deferTodo, listIdeas, listTodos, promoteIdea } from "../herdr/todos/work-item-store.js";
import { registerTodosFeature } from "./todos.ts";

test("Todo guidance reserves tracking for distinct commitments", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand() {},
	};
	registerTodosFeature(pi as never);

	const prompt = handlers.get("before_agent_start")?.({ systemPrompt: "base" }).systemPrompt;
	assert.match(prompt, /For one user request with one cohesive deliverable, work directly and report the result\./);
	assert.match(prompt, /Create Todos when the session has multiple distinct commitments/);
	assert.deepEqual(tools.get("todo").promptGuidelines, [
		"For one cohesive user request, work directly and report the result.",
		"Create Todos for multiple distinct session commitments, explicitly tracked work, or follow-ups that must remain visible across turns; use Ideas for project-wide work retained for later.",
	]);
});

test("the ledger keeps provenance while ownership follows promotion", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-ledger-provenance-"));
	try {
		const idea = createIdea(cwd, { title: "Review later", intent: "Keep context", createdInSessionId: "origin" });
		const promoted = promoteIdea(cwd, idea.id, "current");
		assert.equal(promoted.todo.id, idea.id);
		assert.equal(promoted.todo.createdInSessionId, "origin");
		assert.equal(promoted.todo.ownerSessionId, "current");
		assert.equal(listIdeas(cwd).length, 0);
		const deferred = deferTodo(cwd, promoted.todo.id, "current");
		assert.equal(deferred.idea.id, idea.id);
		assert.equal(deferred.idea.createdInSessionId, "origin");
		assert.equal(listTodos(cwd, { sessionId: "current" }).length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("done Todos cannot be deferred", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-ledger-completed-"));
	try {
		const todo = createTodo(cwd, { title: "Done", ownerSessionId: "current", createdInSessionId: "current" });
		completeTodo(cwd, todo.id);
		assert.equal(deferTodo(cwd, todo.id, "current"), undefined);
		assert.equal(listIdeas(cwd).length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
