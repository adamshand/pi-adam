import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeTodo, createIdea, createTodo, deferTodo, listIdeas, listTodos, promoteIdea } from "../herdr/todos/work-item-store.js";
import { registerTodosFeature } from "./todos.ts";
import { createTestExtensionApi } from "./test-extension.ts";

test("Todo guidance reserves tracking for distinct commitments", () => {
	type PromptHandler = (event: { systemPrompt: string }) => { systemPrompt: string };
	type RegisteredTool = { name: string; promptGuidelines: string[] };
	const handlers = new Map<string, PromptHandler>();
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		on(name: string, handler: PromptHandler) { handlers.set(name, handler); },
		registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
		registerCommand() {},
	};
	registerTodosFeature(createTestExtensionApi(pi));

	const prompt = handlers.get("before_agent_start")?.({ systemPrompt: "base" }).systemPrompt;
	assert.ok(prompt);
	assert.match(prompt, /For one user request with one cohesive deliverable, work directly and report the result\./);
	assert.match(prompt, /Create Todos when the session has multiple distinct commitments/);
	const todoTool = tools.get("todo");
	assert.ok(todoTool);
	assert.deepEqual(todoTool.promptGuidelines, [
		"For one cohesive user request, work directly and report the result.",
		"Create Todos for multiple distinct session commitments, explicitly tracked work, or follow-ups that must remain visible across turns; use Ideas for project-wide work retained for later.",
	]);
});

test("the ledger keeps provenance while ownership follows promotion", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-ledger-provenance-"));
	try {
		const idea = createIdea(cwd, { title: "Review later", intent: "Keep context", createdInSessionId: "origin" });
		const promoted = promoteIdea(cwd, idea.id, "current");
		assert.ok(promoted);
		assert.equal(promoted.todo.id, idea.id);
		assert.equal(promoted.todo.createdInSessionId, "origin");
		assert.equal(promoted.todo.ownerSessionId, "current");
		assert.equal(listIdeas(cwd).length, 0);
		const deferred = deferTodo(cwd, promoted.todo.id, "current");
		assert.ok(deferred);
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
