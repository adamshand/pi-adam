import assert from "node:assert/strict";
import test from "node:test";
import { HERDR_TODOS_LABEL, registerHerdrAppTodosFeature } from "./herdr-app-todos.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";

type Handler = (event: never, ctx: ReturnType<typeof createTestExtensionContext>) => void | Promise<void>;
type Call = { command: string; args: string[] };

function harness(terminal: string | undefined = "t7") {
	const handlers = new Map<string, Handler>();
	const calls: Call[] = [];
	let label = "", name = "Plan the release", fail = false;
	registerHerdrAppTodosFeature(createTestExtensionApi({
		on(event: string, handler: Handler) { handlers.set(event, handler); },
		getSessionName() { return name; },
		async exec(command: string, args: string[]) {
			calls.push({ command, args });
			if (fail) throw new Error("core unavailable");
			if (args[0] === "label") label = args[2].slice(HERDR_TODOS_LABEL.length + 1);
			return { code: 0, stdout: JSON.stringify({ labels: { [HERDR_TODOS_LABEL]: label } }), stderr: "" };
		},
	}), { HC_TERMINAL_ID: terminal });
	const context = (session = "session-one", mode = "tui", cwd = "/project with spaces") => createTestExtensionContext({
		cwd, mode, sessionManager: { getSessionId: () => session },
	});
	const fire = async (event: string, ctx = context()) => {
		// SAFETY: The tested handlers do not inspect the event payload.
		await handlers.get(event)?.(undefined as never, ctx);
	};
	return {
		handlers, calls, fire, context,
		label: () => label, displace: () => { label = "another-runtime"; },
		rename: () => { name = "Updated name"; },
		fail: (value: boolean) => { fail = value; },
	};
}

test("publishes an exact session file in one core label without shell quoting", async () => {
	const h = harness();
	await h.fire("session_start");
	const ref = JSON.parse(h.label());
	assert.equal(ref.session_id, "session-one");
	assert.equal(ref.todo_path, "/project with spaces/.pi/todos/session-one.json");
	assert.equal(ref.name, "Plan the release");
	assert.equal(ref.version, 1);
	assert.match(ref.ideas_reader, /herdr\/app\/ideas\/read-ideas\.js$/);
	assert.equal(ref.node, process.execPath);
	assert.ok(ref.owner);
	assert.equal(h.calls[0].command, "hc");
	assert.deepEqual(h.calls[0].args.slice(0, 2), ["label", "t7"]);
	assert.equal(h.calls[0].args.length, 3);
});

test("unavailable outside a core terminal and inert in headless modes", async () => {
	assert.equal(harness("").handlers.size, 0);
	for (const mode of ["rpc", "json", "print"]) {
		const h = harness();
		await h.fire("session_start", h.context("s", mode));
		await h.fire("agent_start", h.context("s", mode));
		await h.fire("session_shutdown", h.context("s", mode));
		assert.equal(h.calls.length, 0);
	}
});

test("deduplicates ordinary agent starts, but updates the session name", async () => {
	const h = harness();
	await h.fire("session_start");
	await h.fire("agent_start");
	assert.equal(h.calls.length, 1);
	h.rename();
	await h.fire("session_info_changed");
	assert.equal(JSON.parse(h.label()).name, "Updated name");
	assert.equal(h.calls.length, 2);
});

test("shutdown removes only this runtime's label and is idempotent", async () => {
	const h = harness();
	await h.fire("session_start");
	await h.fire("session_shutdown");
	assert.equal(h.label(), "");
	assert.deepEqual(h.calls[2].args, ["label", "t7", `${HERDR_TODOS_LABEL}=`]);
	await h.fire("session_shutdown");
	assert.equal(h.calls.length, 3);
});

test("shutdown does not clear another runtime's session publication", async () => {
	const h = harness();
	await h.fire("session_start");
	h.displace();
	await h.fire("session_shutdown");
	assert.equal(h.label(), "another-runtime");
	assert.equal(h.calls.filter(call => call.args[0] === "label").length, 1);
});

test("session replacement changes the owner and exact session file", async () => {
	const h = harness();
	await h.fire("session_start");
	const old = JSON.parse(h.label());
	await h.fire("session_shutdown");
	await h.fire("session_start", h.context("session_two.new", "tui", "/another"));
	const next = JSON.parse(h.label());
	assert.notEqual(next.owner, old.owner);
	assert.equal(next.todo_path, "/another/.pi/todos/session%5Ftwo%2Enew.json");
});

test("a failed core publication never interrupts Pi and retries on the next run", async () => {
	const h = harness();
	h.fail(true);
	await h.fire("session_start");
	assert.equal(h.label(), "");
	h.fail(false);
	await h.fire("agent_start");
	assert.equal(JSON.parse(h.label()).session_id, "session-one");
});
