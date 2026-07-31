import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerHerdrTodosFeature } from "./herdr-todos.ts";
import { listTodos, sessionTag } from "../herdr/todos/todo-store.js";

function restoreEnv(previous: Record<string, string | undefined>) {
	for (const [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

test("/todos reports that its board requires Herdr", async () => {
	const previous = { HERDR_ENV: process.env.HERDR_ENV };
	delete process.env.HERDR_ENV;
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	const pi = {
		on() {},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
	};
	try {
		registerHerdrTodosFeature(pi as never);
		assert.ok(commands.has("todos"));
		assert.ok(!commands.has("herdr-todos"));
		await commands.get("todos").handler("", { ui: { notify(message: string) { notifications.push(message); } } });
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
	const directory = join(cwd, ".pi", "todos");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "current.md"), `${JSON.stringify({ id: "current", title: "Current work", status: "open", tags: [sessionTag("session-one")], created_at: "current" }, null, 2)}\n\n`);
	writeFileSync(join(directory, "other.md"), `${JSON.stringify({ id: "other", title: "Other work", status: "open", tags: [sessionTag("session-two")], created_at: "other" }, null, 2)}\n\n`);
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const executions: string[][] = [];
	const notifications: string[] = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
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
		registerHerdrTodosFeature(pi as never);
		await handlers.get("session_start")?.({}, ctx);
		const openArgs = executions.find((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open");
		assert.ok(openArgs?.includes("PI_ADAM_TODO_VIEW=todos"));
		await commands.get("todos").handler("view ideas", ctx);
		await commands.get("todos").handler("status", ctx);
		assert.ok(notifications.some((message) => message.includes("1 active") && message.includes("view ideas")));
		await commands.get("todos").handler("close", ctx);
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
	const directory = join(cwd, ".pi", "todos");
	mkdirSync(directory, { recursive: true });
	const add = (id: string, sessionId: string, status: string) => writeFileSync(join(directory, `${id}.md`), `${JSON.stringify({ id, title: id, status, tags: [sessionTag(sessionId)], created_at: id }, null, 2)}\n\n`);
	add("current-done", "session-one", "closed");
	add("current-open", "session-one", "open");
	add("other-done", "session-two", "closed");
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		async exec() { return { code: 1, stdout: "", stderr: "mock" }; },
	};
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "session-one" },
		ui: { notify() {}, async confirm() { return true; } },
	};
	try {
		registerHerdrTodosFeature(pi as never);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("todos").handler("clear", ctx);
		assert.deepEqual(listTodos(cwd).map((todo) => todo.id), ["current-open", "other-done"]);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
		restoreEnv(previous);
	}
});
