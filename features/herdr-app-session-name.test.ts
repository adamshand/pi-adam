import assert from "node:assert/strict";
import test from "node:test";
import { registerHerdrSessionNameFeature } from "./herdr-session-name.ts";
import { createTestExtensionApi } from "./test-extension.ts";

type Handler = (event: { name?: string; reason?: string }, ctx: { mode: string }) => void | Promise<void>;
type Call = { command: string; args: string[] };

function harness(name?: string) {
	const handlers = new Map<string, Handler>();
	const calls: Call[] = [];
	let tab = "tb-owned", response: string | undefined, fail = false;
	registerHerdrSessionNameFeature(createTestExtensionApi({
		on(event: string, handler: Handler) { handlers.set(event, handler); },
		getSessionName() { return name; },
		async exec(command: string, args: string[]) {
			calls.push({ command, args });
			if (fail) throw new Error("unavailable");
			return { code: 0, stdout: response ?? JSON.stringify({ labels: { "herdr.tab": tab } }), stderr: "" };
		},
	}), { HC_TERMINAL_ID: "t7" });
	const fire = async (event: string, value: { name?: string; reason?: string }, mode = "tui") => {
		await handlers.get(event)?.(value, { mode });
	};
	return { calls, fire, move: (value: string) => { tab = value; }, corrupt: (value: string) => { response = value; }, fail: (value: boolean) => { fail = value; } };
}

test("/name explicitly renames the Pi terminal's tab in the new app", async () => {
	const h = harness();
	await h.fire("session_info_changed", { name: "foo with spaces" });
	assert.deepEqual(h.calls, [
		{ command: "hc", args: ["get", "t7"] },
		{ command: "herdr-app", args: ["do", "tab.rename", JSON.stringify({ id: "tb-owned", name: "foo with spaces" })] },
	]);
});

test("clearing a name restores automatic numbering rather than a fixed numeric name", async () => {
	const h = harness();
	await h.fire("session_info_changed", { name: "  " });
	assert.deepEqual(JSON.parse(h.calls[1].args[2]), { id: "tb-owned", name: "" });
});

test("each rename resolves the terminal's current tab after a move", async () => {
	const h = harness();
	await h.fire("session_info_changed", { name: "first" });
	h.move("tb-moved");
	await h.fire("session_info_changed", { name: "second" });
	assert.equal(JSON.parse(h.calls[3].args[2]).id, "tb-moved");
});

test("named sessions synchronize on startup, resume and reload", async () => {
	for (const reason of ["startup", "resume", "reload"]) {
		const h = harness("release");
		await h.fire("session_start", { reason });
		assert.equal(JSON.parse(h.calls[1].args[2]).name, "release");
	}
});

test("unnamed startup/reload preserves manual names; session replacement resets them", async () => {
	for (const reason of ["startup", "reload"]) {
		const h = harness(); await h.fire("session_start", { reason });
		assert.equal(h.calls.length, 0);
	}
	const h = harness(); await h.fire("session_start", { reason: "new" });
	assert.equal(JSON.parse(h.calls[1].args[2]).name, "");
});

test("headless sessions and hidden/unlabelled terminals cannot rename the focused tab", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const h = harness("release");
		await h.fire("session_start", { reason: "startup" }, mode);
		await h.fire("session_info_changed", { name: "new" }, mode);
		assert.equal(h.calls.length, 0);
	}
	for (const response of ["{", JSON.stringify({ labels: {} })]) {
		const h = harness(); h.corrupt(response);
		await h.fire("session_info_changed", { name: "new" });
		assert.equal(h.calls.length, 1);
	}
});

test("core failures never interrupt Pi and subsequent name changes still work", async () => {
	const h = harness(); h.fail(true);
	await h.fire("session_info_changed", { name: "first" });
	h.fail(false);
	await h.fire("session_info_changed", { name: "second" });
	assert.equal(JSON.parse(h.calls.at(-1)!.args[2]).name, "second");
});
