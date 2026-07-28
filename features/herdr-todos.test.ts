import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerHerdrTodosFeature } from "./herdr-todos.ts";
import { listTodos, sessionTag } from "../herdr-plugin/todo-store.js";

test("tags created todos and clears completed todos in session scope", async () => {
	const previousHerdrEnv = process.env.HERDR_ENV;
	process.env.HERDR_ENV = "1";
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-feature-"));
	const directory = join(cwd, ".pi", "todos");
	mkdirSync(directory, { recursive: true });
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const notifications: string[] = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand(name: string, command: { handler: (...args: any[]) => any }) { commands.set(name, command); },
		async exec() { return { code: 1, stdout: "", stderr: "mock Herdr" }; },
	};
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "session-one" },
		ui: {
			notify(message: string) { notifications.push(message); },
			async confirm() { return true; },
		},
	};

	try {
		registerHerdrTodosFeature(pi as never);
		await handlers.get("session_start")?.({}, ctx);

		const createInput: { action: string; tags?: string[] } = { action: "create" };
		handlers.get("tool_call")?.({ toolName: "todo", input: createInput });
		assert.deepEqual(createInput.tags, [sessionTag("session-one")]);

		const projectInput = { action: "create", tags: ["project"] };
		handlers.get("tool_call")?.({ toolName: "todo", input: projectInput });
		assert.deepEqual(projectInput.tags, ["project"]);

		const writeTodo = (id: string, status: string, tags: string[]) => {
			writeFileSync(join(directory, `${id}.md`), `${JSON.stringify({ id, title: id, status, tags, created_at: id }, null, 2)}\n\nbody\n`);
		};
		writeTodo("session-done", "closed", [sessionTag("session-one")]);
		writeTodo("session-open", "open", [sessionTag("session-one")]);
		writeTodo("other-done", "closed", [sessionTag("session-two")]);

		await commands.get("herdr-todos")?.handler("clear", ctx);
		assert.deepEqual(listTodos(cwd, { scope: "project" }).map((todo) => todo.id), ["other-done", "session-open"]);
		assert.ok(notifications.some((message) => message.includes("cleared 1 completed session todo")));
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
	}
});
