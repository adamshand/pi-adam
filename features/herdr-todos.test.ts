import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerHerdrTodosFeature } from "./herdr-todos.ts";
import { listTodos, sessionTag, todoState } from "../herdr-plugin/todo-store.js";

test("user can add a todo to the current session with /todo", async () => {
	const previousHerdrEnv = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-add-todo-"));
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand(name: string, command: { handler: (...args: any[]) => any }) { commands.set(name, command); },
		async exec() { return { code: 1, stdout: "", stderr: "mock Herdr" }; },
	};
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "session-one" },
		ui: { notify() {}, async confirm() { return true; }, async input() { return undefined; } },
	};

	try {
		registerHerdrTodosFeature(pi as never);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("todo")?.handler("Buy milk", ctx);

		const todos = listTodos(cwd, { scope: "session", sessionId: "session-one" });
		assert.equal(todos.length, 1);
		assert.equal(todos[0].title, "Buy milk");
		assert.deepEqual(todos[0].tags, [sessionTag("session-one")]);
		assert.equal(todoState(todos[0]), "outstanding");
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
	}
});

test("user can add a project-wide todo with /todo --project", async () => {
	const previousHerdrEnv = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-add-project-todo-"));
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand(name: string, command: { handler: (...args: any[]) => any }) { commands.set(name, command); },
		async exec() { return { code: 1, stdout: "", stderr: "mock Herdr" }; },
	};
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "session-one" },
		ui: { notify() {}, async confirm() { return true; }, async input() { return undefined; } },
	};

	try {
		registerHerdrTodosFeature(pi as never);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("todo")?.handler("--project Fix release workflow", ctx);

		const projectTodos = listTodos(cwd, { scope: "project" });
		assert.equal(projectTodos.length, 1);
		assert.equal(projectTodos[0].title, "Fix release workflow");
		assert.deepEqual(projectTodos[0].tags, ["project"]);
		assert.equal(todoState(projectTodos[0]), "outstanding");
		assert.equal(listTodos(cwd, { scope: "session", sessionId: "session-one" }).length, 0);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
	}
});

test("/todo prompts for a title and cancellation creates nothing", async () => {
	const previousHerdrEnv = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-prompt-todo-"));
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	let inputCalls = 0;
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand(name: string, command: { handler: (...args: any[]) => any }) { commands.set(name, command); },
		async exec() { return { code: 1, stdout: "", stderr: "mock Herdr" }; },
	};
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "session-one" },
		ui: {
			notify() {},
			async confirm() { return true; },
			async input() {
				inputCalls += 1;
				return inputCalls === 1 ? "Call dentist" : undefined;
			},
		},
	};

	try {
		registerHerdrTodosFeature(pi as never);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("todo")?.handler("", ctx);
		await commands.get("todo")?.handler("", ctx);

		assert.equal(inputCalls, 2);
		const todos = listTodos(cwd, { scope: "session", sessionId: "session-one" });
		assert.equal(todos.length, 1);
		assert.equal(todos[0].title, "Call dentist");
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
	}
});

test("adding a todo automatically opens its Herdr board", async () => {
	const previousEnv = {
		herdr: process.env.HERDR_ENV,
		pane: process.env.HERDR_PANE_ID,
		workspace: process.env.HERDR_WORKSPACE_ID,
	};
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "workspace:source";
	process.env.HERDR_WORKSPACE_ID = "workspace";
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-open-todo-"));
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const executions: string[][] = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand(name: string, command: { handler: (...args: any[]) => any }) { commands.set(name, command); },
		async exec(_command: string, args: string[]) {
			executions.push(args);
			if (args[0] === "pane" && args[1] === "list") return { code: 0, stdout: '{"result":{"panes":[]}}', stderr: "" };
			if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
				return { code: 0, stdout: '{"result":{"plugin_pane":{"pane":{"pane_id":"workspace:board"}}}}', stderr: "" };
			}
			return { code: 0, stdout: "{}", stderr: "" };
		},
	};
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "session-one" },
		ui: { notify() {}, async confirm() { return true; }, async input() { return undefined; } },
	};

	try {
		registerHerdrTodosFeature(pi as never);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("todo")?.handler("Open the board", ctx);

		assert.ok(executions.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open"));
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
		if (previousEnv.herdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousEnv.herdr;
		if (previousEnv.pane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previousEnv.pane;
		if (previousEnv.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previousEnv.workspace;
	}
});

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
