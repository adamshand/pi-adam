import assert from "node:assert/strict";
import test from "node:test";
import { HerdrFooterBridge, HERDR_FOOTER_LABEL, HERDR_FOOTER_HOST_LABEL, type HerdrFooterMetrics } from "./herdr-app-footer.ts";
import { createTestExtensionApi } from "./test-extension.ts";

const metrics: HerdrFooterMetrics = {
	model: "gpt-test", thinking: "high", fast: "on", cost: 1.25,
	contextTokens: 250, contextWindow: 1000, speed: 42,
	usage: { status: "ready", weeklyUsed: 12 },
};

function harness(environment = { HC_TERMINAL_ID: "t7" }) {
	type CoreLabels = Record<string, string>;
	const labels: CoreLabels = { "herdr.tab": "tab7" };
	const writes: string[] = [];
	let calls = 0;
	let changes = 0;
	let fail = false;
	let host = true;
	const bridge = new HerdrFooterBridge(createTestExtensionApi({
		async exec(command: string, args: string[]) {
			calls += 1;
			assert.equal(command, "hc");
			assert.equal(args[1], "t7");
			if (fail) return { code: 1, stdout: "" };
			if (args[0] === "get") {
				const published = labels[HERDR_FOOTER_LABEL];
				if (host && published) labels[HERDR_FOOTER_HOST_LABEL] = JSON.parse(published).owner;
				return { code: 0, stdout: JSON.stringify({ labels }) };
			}
			const assignment = args[2];
			writes.push(assignment);
			const split = assignment.indexOf("=");
			labels[assignment.slice(0, split)] = assignment.slice(split + 1);
			return { code: 0, stdout: "" };
		},
	}), () => { changes += 1; }, environment);
	return { bridge, labels, writes, calls: () => calls, changes: () => changes,
		fail: (value: boolean) => { fail = value; }, host: (value: boolean) => { host = value; } };
}

test("publishes nonsecret metrics, requires native acknowledgement, and deduplicates writes", async () => {
	const h = harness();
	await h.bridge.publish("session-1", metrics);
	assert.equal(h.bridge.active, true);
	assert.equal(h.changes(), 1);
	const snapshot = JSON.parse(h.labels[HERDR_FOOTER_LABEL]);
	assert.deepEqual(snapshot, { version: 1, owner: snapshot.owner, session_id: "session-1", ...metrics });
	await h.bridge.publish("session-1", metrics);
	assert.equal(h.writes.length, 1);
	await h.bridge.publish("session-1", { ...metrics, cost: 2 });
	assert.equal(h.writes.length, 2);
	await h.bridge.stop();
	assert.equal(h.labels[HERDR_FOOTER_LABEL], "");
	assert.equal(h.bridge.active, false);
});

test("HC alone and ordinary terminals cannot hide Pi's footer", async () => {
	const outside = harness({ HC_TERMINAL_ID: "" });
	await outside.bridge.publish("s", metrics);
	assert.equal(outside.calls(), 0);
	const core = harness();
	delete core.labels["herdr.tab"];
	await core.bridge.publish("s", metrics);
	assert.equal(core.writes.length, 0);
	assert.equal(core.bridge.active, false);
});

test("a layout without the native footer leaves the terminal footer available", async () => {
	const h = harness();
	h.host(false);
	await h.bridge.publish("s", metrics);
	assert.equal(h.bridge.active, false);
	h.host(true);
	await h.bridge.publish("s", metrics);
	assert.equal(h.bridge.active, true);
});

test("core failures fall back without throwing, then recover", async () => {
	const h = harness();
	await h.bridge.publish("s", metrics);
	h.fail(true);
	await h.bridge.publish("s", { ...metrics, thinking: "low" });
	assert.equal(h.bridge.active, false);
	h.fail(false);
	await h.bridge.publish("s", { ...metrics, thinking: "low" });
	assert.equal(h.bridge.active, true);
});

test("cleanup is owned, idempotent, and cannot overwrite a replacement runtime", async () => {
	const h = harness();
	await h.bridge.publish("s", metrics);
	h.labels[HERDR_FOOTER_LABEL] = "new owner";
	await h.bridge.stop();
	await h.bridge.stop();
	await h.bridge.publish("s", metrics);
	assert.equal(h.labels[HERDR_FOOTER_LABEL], "new owner");
	assert.equal(h.writes.length, 1);
});

test("queued publications cannot leak beyond shutdown", async () => {
	const h = harness();
	const first = h.bridge.publish("s", metrics);
	const second = h.bridge.publish("s", { ...metrics, cost: 3 });
	await h.bridge.stop();
	await Promise.all([first, second]);
	assert.equal(h.writes.length, 0);
});
