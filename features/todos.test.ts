import assert from "node:assert/strict";
import test from "node:test";
import { createTodo, listTodos } from "../herdr/todos/work-item-store.js";
import { WorkIdeas } from "../herdr/todos/work-ideas.js";
import { workFixture } from "../herdr/todos/work-test-fixture.js";
import { registerTodosFeature } from "./todos.ts";
import { createTestExtensionApi } from "./test-extension.ts";

test("Todo and Idea guidance explains who each is for", () => {
	type RegisteredTool = { name: string; promptGuidelines: string[] };
	const tools = new Map<string, RegisteredTool>();
	const events: string[] = [];
	const pi = {
		on(name: string) { events.push(name); },
		registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
		registerCommand() {},
	};
	registerTodosFeature(createTestExtensionApi(pi));

	assert.ok(!events.includes("before_agent_start"), "guidance lives in promptGuidelines, not the system prompt");
	assert.match(tools.get("todo")?.promptGuidelines.join("\n") ?? "", /Adam's view of the current task/);
	assert.match(tools.get("idea")?.promptGuidelines.join("\n") ?? "", /tangent comes up/);
});

test("Work promotion links a Todo, is repeatable, and deferral preserves remote identity", async () => {
 const f = await workFixture();
 try {
  const ideas = new WorkIdeas(f.client);
  const capture = await f.client.create(f.cwd, { title: "Review later", intent: "Keep context" });
  assert.ok(capture.item);
  const todo = await ideas.promote(f.cwd, capture.item.id, "current");
  assert.equal(todo.workId, capture.item.id);
  assert.equal(todo.workUrl, f.client.url);
  assert.equal(todo.ownerSessionId, "current");
  assert.equal((await ideas.promote(f.cwd, capture.item.id, "current")).id, todo.id);
  assert.equal(listTodos(f.cwd).length, 1);
  assert.equal(f.items.get(capture.item.id)?.state, "open");
  await ideas.defer(f.cwd, todo.id, "current");
  assert.equal(f.items.get(capture.item.id)?.state, "inbox");
  assert.equal(listTodos(f.cwd).length, 0);
 } finally { await f.close(); }
});

test("failed deferral retains Todo and replay cannot duplicate an unlinked capture", async () => {
 const f = await workFixture();
 try {
  const ideas = new WorkIdeas(f.client);
  const todo = createTodo(f.cwd, { title: "Later", ownerSessionId: "current" });
  f.control.loseCreateResponse = true;
  assert.equal((await ideas.defer(f.cwd, todo.id, "current")).queued, true);
  assert.equal(listTodos(f.cwd).length, 1);
  await f.client.list(f.cwd);
  assert.equal((await ideas.defer(f.cwd, todo.id, "current")).queued, false);
  assert.equal(f.items.size, 1);
  assert.equal(listTodos(f.cwd).length, 0);
  const done = createTodo(f.cwd, { title: "Done", ownerSessionId: "current", status: "done" });
  await assert.rejects(ideas.defer(f.cwd, done.id, "current"), /unfinished/);
 } finally { await f.close(); }
});

test("Work updates preserve unrelated Markdown and concurrent changes", async () => {
 const f = await workFixture();
 try {
  const ideas = new WorkIdeas(f.client);
  const capture = await f.client.create(f.cwd, { title: "Edit", intent: "Reporter context" });
  assert.ok(capture.item);
  f.control.conflicts = 1;
  const updated = await ideas.update(f.cwd, capture.item.id, { intent: "Our intent", checklist: [{ text: "Check" }] });
  assert.match(updated.description, /Reporter context\nConcurrent edit/);
  const again = await ideas.update(f.cwd, capture.item.id, { intent: "New intent" });
  assert.ok(!again.description.includes("Our intent"));
  assert.match(again.description, /New intent/);
  assert.match(again.description, /- \[ \] Check/);
 } finally { await f.close(); }
});
