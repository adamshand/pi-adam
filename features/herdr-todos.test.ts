import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { registerHerdrTodosFeature } from "./herdr-todos.ts";
import { listIdeas } from "../herdr-plugin/idea-store.js";
import { listTodos, sessionTag, todoState } from "../herdr-plugin/todo-store.js";

test("agent receives outcome-oriented todo guidance before starting", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand() {},
	};
	registerHerdrTodosFeature(pi as never);

	const result = await handlers.get("before_agent_start")?.({ systemPrompt: "Base prompt" }, {});
	assert.match(result?.systemPrompt ?? "", /3–7 outcome-level todos/);
	assert.match(result?.systemPrompt ?? "", /Before settling, reconcile/);
	assert.match(result?.systemPrompt ?? "", /acceptance criteria/);
});

test("user can capture a non-actionable project idea with /idea", async () => {
	const previousHerdrEnv = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-add-idea-"));
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand(name: string, command: { handler: (...args: any[]) => any }) { commands.set(name, command); },
		registerTool() {},
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
		await commands.get("idea")?.handler("Explore durable memory", ctx);

		const ideas = listIdeas(cwd);
		assert.equal(ideas.length, 1);
		assert.equal(ideas[0].title, "Explore durable memory");
		assert.equal(listTodos(cwd, { scope: "project" }).length, 0);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
	}
});

test("agent can capture project context with the idea tool", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-agent-idea-"));
	let ideaTool: any;
	const pi = {
		on() {},
		registerCommand() {},
		registerTool(tool: any) { if (tool.name === "idea") ideaTool = tool; },
	};
	const ctx = { cwd, sessionManager: { getSessionId: () => "session-one" } };

	try {
		registerHerdrTodosFeature(pi as never);
		assert.ok(ideaTool);
		const result = await ideaTool.execute("call", {
			action: "create",
			title: "Explore a later project",
			body: "Context that should survive this conversation.",
		}, undefined, undefined, ctx);

		assert.match(result.content[0].text, /Captured idea/);
		const ideas = listIdeas(cwd);
		assert.equal(ideas.length, 1);
		assert.equal(ideas[0].title, "Explore a later project");
		assert.equal(ideas[0].body, "Context that should survive this conversation.");

		await ideaTool.execute("call", {
			action: "update",
			id: result.details.id,
			title: "Explore durable project memory",
			body: "Sharpened context.",
		}, undefined, undefined, ctx);
		const listed = await ideaTool.execute("call", { action: "list" }, undefined, undefined, ctx);
		assert.match(listed.content[0].text, /Explore durable project memory/);
		assert.equal(listIdeas(cwd)[0].body, "Sharpened context.");

		await ideaTool.execute("call", { action: "delete", id: result.details.id }, undefined, undefined, ctx);
		assert.equal(listIdeas(cwd).length, 0);

		const future = await ideaTool.execute("call", {
			action: "create",
			title: "Promote this later",
		}, undefined, undefined, ctx);
		await ideaTool.execute("call", { action: "promote", id: future.details.id }, undefined, undefined, ctx);
		assert.equal(listIdeas(cwd).length, 0);
		const promoted = listTodos(cwd, { scope: "session", sessionId: "session-one" });
		assert.equal(promoted.length, 1);
		assert.equal(promoted[0].title, "Promote this later");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

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

test("adding a todo opens its board and board scope changes reach the controller", async () => {
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
	const notifications: string[] = [];
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
		ui: { notify(message: string) { notifications.push(message); }, async confirm() { return true; }, async input() { return undefined; } },
	};

	try {
		registerHerdrTodosFeature(pi as never);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("herdr-todos")?.handler("view ideas", ctx);
		await commands.get("idea")?.handler("Do not auto-open", ctx);
		assert.ok(!executions.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open"));

		await commands.get("todo")?.handler("Open the board", ctx);
		const openArgs = executions.find((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open");
		assert.ok(openArgs);
		assert.ok(openArgs.includes("PI_ADAM_TODO_VIEW=session"));
		const stateSetting = openArgs.find((arg) => arg.startsWith("PI_ADAM_TODO_STATE_PATH="));
		assert.ok(stateSetting);
		const statePath = stateSetting.slice("PI_ADAM_TODO_STATE_PATH=".length);
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, `${JSON.stringify({ view: "all", lastTodoView: "all" }, null, 2)}\n`);
		await commands.get("herdr-todos")?.handler("refresh", ctx);
		await commands.get("herdr-todos")?.handler("status", ctx);
		assert.ok(notifications.some((message) => message.includes("all todos")));
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
