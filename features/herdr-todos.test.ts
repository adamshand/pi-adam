import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTodo, listTodos } from "../herdr/todos/work-item-store.js";
import { registerHerdrTodosFeature } from "./herdr-todos.ts";
import { createTestExtensionApi } from "./test-extension.ts";

type EmptyEvent = Record<never, never>;
type HarnessContext = {
	cwd?: string;
	sessionManager?: { getSessionId(): string };
	ui: {
		notify(message: string): void;
		confirm?(): Promise<boolean>;
	};
};
type Handler = (event: EmptyEvent, ctx: HarnessContext) => void | Promise<void>;
type Command = { handler(args: string, ctx: HarnessContext): void | Promise<void> };

function restoreEnv(previous: Record<string, string | undefined>) {
	for (const [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

test("/todos reports that its board requires Herdr", async () => {
	const previous = { HERDR_ENV: process.env.HERDR_ENV };
	delete process.env.HERDR_ENV;
	const commands = new Map<string, Command>();
	const notifications: string[] = [];
	const pi = {
		on() {},
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		registerShortcut() {},
	};
	try {
		registerHerdrTodosFeature(createTestExtensionApi(pi));
		assert.ok(commands.has("todos"));
		assert.ok(!commands.has("herdr-todos"));
		const todosCommand = commands.get("todos");
		assert.ok(todosCommand);
		await todosCommand.handler("", { ui: { notify(message: string) { notifications.push(message); } } });
		assert.ok(notifications.some((message) => message.includes("requires Herdr")));
	} finally {
		restoreEnv(previous);
	}
});

test("current-session Todos automatically open the two-view board", async () => {
	const previous = {
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_PANE_ID: process.env.HERDR_PANE_ID,
		HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
	};
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "workspace:source";
	process.env.HERDR_WORKSPACE_ID = "workspace";
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-herdr-controller-"));
	createTodo(cwd, { id: "current", title: "Current work", ownerSessionId: "session-one", createdInSessionId: "session-one" });
	createTodo(cwd, { id: "other", title: "Other work", ownerSessionId: "session-two", createdInSessionId: "session-two" });
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const executions: string[][] = [];
	const notifications: string[] = [];
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		registerShortcut() {},
		async exec(_command: string, args: string[]) {
			executions.push(args);
			if (args[0] === "pane" && args[1] === "list") return { code: 0, stdout: '{"result":{"panes":[]}}', stderr: "" };
			if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") return { code: 0, stdout: '{"result":{"plugin_pane":{"pane":{"pane_id":"workspace:board"}}}}', stderr: "" };
			return { code: 0, stdout: "{}", stderr: "" };
		},
	};
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "session-one" },
		ui: { notify(message: string) { notifications.push(message); }, async confirm() { return true; } },
	};
	try {
		registerHerdrTodosFeature(createTestExtensionApi(pi));
		await handlers.get("session_start")?.({}, ctx);
		const openArgs = executions.find((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open");
		assert.ok(openArgs?.includes("PI_ADAM_TODO_VIEW=todos"));
		assert.ok(executions.some((args) => args.join(" ") === "pane rename workspace:board Todo · session-"));
		const todosCommand = commands.get("todos");
		assert.ok(todosCommand);
		await todosCommand.handler("view ideas", ctx);
		await todosCommand.handler("status", ctx);
		assert.ok(notifications.some((message) => message.includes("1 active") && message.includes("view ideas")));
		await todosCommand.handler("close", ctx);
		assert.ok(executions.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "close"));
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
		restoreEnv(previous);
	}
});

test("/todos clear removes completed Todos only from the current session", async () => {
	const previous = { HERDR_ENV: process.env.HERDR_ENV };
	process.env.HERDR_ENV = "1";
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-herdr-clear-"));
	const add = (id: string, ownerSessionId: string, status: string) => createTodo(cwd, { id, title: id, status, ownerSessionId, createdInSessionId: ownerSessionId });
	add("current-done", "session-one", "completed");
	add("current-open", "session-one", "open");
	add("other-done", "session-two", "closed");
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		registerShortcut() {},
		async exec() { return { code: 1, stdout: "", stderr: "mock" }; },
	};
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "session-one" },
		ui: { notify() {}, async confirm() { return true; } },
	};
	try {
		registerHerdrTodosFeature(createTestExtensionApi(pi));
		await handlers.get("session_start")?.({}, ctx);
		const todosCommand = commands.get("todos");
		assert.ok(todosCommand);
		await todosCommand.handler("clear", ctx);
		assert.deepEqual(listTodos(cwd).map((todo) => todo.id), ["current-open", "other-done"]);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
		restoreEnv(previous);
	}
});
