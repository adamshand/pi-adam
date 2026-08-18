import assert from "node:assert/strict";
import test from "node:test";
import { delimiter } from "node:path";
import {
	parseActiveAgentBrowserSessions,
	registerAgentBrowserFeature,
} from "./agent-browser.ts";

type Handler = (event: any, ctx?: any) => unknown;

type ExecCall = {
	command: string;
	args: string[];
	options: unknown;
};

function createHarness(activeSessions: string[] = []) {
	const handlers = new Map<string, Handler>();
	const calls: ExecCall[] = [];
	const environment: Record<string, string | undefined> = { PATH: "/usr/bin" };
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		async exec(command: string, args: string[], options: unknown) {
			calls.push({ command, args, options });
			if (args.join(" ") === "session list --json") {
				return {
					code: 0,
					stdout: JSON.stringify({ success: true, data: { sessions: activeSessions } }),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};

	registerAgentBrowserFeature(pi as any, environment);

	const context = (sessionId: string) => ({
		sessionManager: { getSessionId: () => sessionId },
	});

	return { calls, context, environment, handlers };
}

test("configures a pinned CLI and isolated defaults for each Pi session", () => {
	const { context, environment, handlers } = createHarness();
	handlers.get("session_start")?.({ reason: "startup" }, context("019f-session-one"));

	assert.equal(environment.AGENT_BROWSER_SESSION, "pi-019f-session-one");
	assert.equal(environment.AGENT_BROWSER_CONTENT_BOUNDARIES, "1");
	assert.equal(environment.AGENT_BROWSER_MAX_OUTPUT, "12000");
	assert.equal(environment.AGENT_BROWSER_IDLE_TIMEOUT_MS, "900000");
	assert.equal(
		(environment.PATH ?? "").split(delimiter)[0]?.endsWith("node_modules/.bin"),
		true,
	);
});

test("preserves explicit browser output and timeout defaults", () => {
	const { context, environment, handlers } = createHarness();
	environment.AGENT_BROWSER_MAX_OUTPUT = "8000";
	environment.AGENT_BROWSER_IDLE_TIMEOUT_MS = "60000";
	handlers.get("session_start")?.({ reason: "startup" }, context("session"));

	assert.equal(environment.AGENT_BROWSER_MAX_OUTPUT, "8000");
	assert.equal(environment.AGENT_BROWSER_IDLE_TIMEOUT_MS, "60000");
});

test("updates the browser session after Pi replaces its active session", () => {
	const { context, environment, handlers } = createHarness();
	handlers.get("session_start")?.({ reason: "startup" }, context("first"));
	handlers.get("session_start")?.({ reason: "new" }, context("second"));

	assert.equal(environment.AGENT_BROWSER_SESSION, "pi-second");
});

test("keeps an active browser running across extension reloads", async () => {
	const { calls, context, environment, handlers } = createHarness(["pi-session"]);
	handlers.get("session_start")?.({ reason: "startup" }, context("session"));
	await handlers.get("session_shutdown")?.({ reason: "reload" });

	assert.deepEqual(calls, []);
	assert.deepEqual(environment, { PATH: "/usr/bin" });
});

test("closes only its active browser session during final shutdown", async () => {
	const { calls, context, environment, handlers } = createHarness(["someone-else", "pi-session"]);
	handlers.get("session_start")?.({ reason: "startup" }, context("session"));
	await handlers.get("session_shutdown")?.({ reason: "quit" });

	assert.deepEqual(calls, [
		{
			command: "agent-browser",
			args: ["session", "list", "--json"],
			options: { timeout: 5000 },
		},
		{
			command: "agent-browser",
			args: ["--session", "pi-session", "close"],
			options: { timeout: 5000 },
		},
	]);
	assert.deepEqual(environment, { PATH: "/usr/bin" });
});

test("does not create browser state just to close an inactive session", async () => {
	const { calls, context, handlers } = createHarness(["someone-else"]);
	handlers.get("session_start")?.({ reason: "startup" }, context("session"));
	await handlers.get("session_shutdown")?.({ reason: "quit" });

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.args, ["session", "list", "--json"]);
});

test("ignores malformed session-list output", () => {
	assert.deepEqual(parseActiveAgentBrowserSessions("not JSON"), []);
	assert.deepEqual(parseActiveAgentBrowserSessions('{"data":{"sessions":["one",2,null]}}'), ["one"]);
});

test("contributes the dynamic agent-browser skill", () => {
	const { handlers } = createHarness();
	const resources = handlers.get("resources_discover")?.({ reason: "startup", cwd: "/src/app" }) as {
		skillPaths: string[];
	};

	assert.equal(resources.skillPaths.length, 1);
	assert.match(resources.skillPaths[0] ?? "", /skills$/);
});
