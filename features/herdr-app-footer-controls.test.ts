import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ScopedModel } from "@earendil-works/pi-coding-agent";
import { applyFooterAction, footerModelRotation, FooterControlServer } from "./herdr-app-footer-controls.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";
import { sendFooterControl } from "../herdr/app/status/control-client.js";

function model(id: string): Model<Api> {
	return { id, name: id, provider: "test", api: "openai-responses", baseUrl: "https://example.test",
		reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null } };
}

function harness() {
	const available = [model("a"), model("b"), model("c")];
	let selected = available[0];
	let thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> = "high";
	let scope: ScopedModel[] = [];
	let busy = false;
	let pending = false;
	let fast = false;
	let mutations = 0;
	const ctx = createTestExtensionContext({
		mode: "tui", get model() { return selected; }, get scopedModels() { return scope; },
		isIdle: () => !busy, hasPendingMessages: () => pending,
		modelRegistry: { getAvailable: () => available },
	});
	const pi = createTestExtensionApi({
		async setModel(next: Model<Api>) { selected = next; mutations += 1; return true; },
		setThinkingLevel(level: ReturnType<ExtensionAPI["getThinkingLevel"]>) { thinking = level; mutations += 1; },
		getThinkingLevel: () => thinking,
	});
	return { ctx, pi, available, selected: () => selected, thinking: () => thinking, fast: () => fast,
		mutations: () => mutations, toggle: () => { fast = !fast; mutations += 1; },
		scope: (value: ScopedModel[]) => { scope = value; }, busy: (value: boolean) => { busy = value; },
		pending: (value: boolean) => { pending = value; } };
}

test("model clicks cycle the authenticated rotation, wrap and honour scoped thinking", async () => {
	const h = harness();
	await applyFooterAction("model", h.pi, h.ctx, h.toggle);
	assert.equal(h.selected().id, "b");
	h.scope([{ model: h.available[1] }, { model: model("missing") }, { model: h.available[2], thinkingLevel: "medium" }]);
	assert.deepEqual(footerModelRotation(h.ctx).map(item => item.model.id), ["b", "c"]);
	await applyFooterAction("model", h.pi, h.ctx, h.toggle);
	assert.equal(h.selected().id, "c");
	assert.equal(h.thinking(), "medium");
	await applyFooterAction("model", h.pi, h.ctx, h.toggle);
	assert.equal(h.selected().id, "b");
});

test("model clicks enter at the first scoped model when the current model is outside the rotation", async () => {
	const h = harness();
	h.scope([{ model: h.available[1] }, { model: h.available[2] }]);
	await applyFooterAction("model", h.pi, h.ctx, h.toggle);
	assert.equal(h.selected().id, "b");
});

test("thinking clicks use the model's capability map, not a hardcoded level list", async () => {
	const h = harness();
	await applyFooterAction("thinking", h.pi, h.ctx, h.toggle);
	assert.equal(h.thinking(), "xhigh");
	await applyFooterAction("thinking", h.pi, h.ctx, h.toggle);
	assert.equal(h.thinking(), "low");
	h.selected().reasoning = false;
	assert.equal((await applyFooterAction("thinking", h.pi, h.ctx, h.toggle)).ok, false);
});

test("Fast uses the existing toggle; busy or queued sessions reject every control without mutation", async () => {
	const h = harness();
	await applyFooterAction("fast", h.pi, h.ctx, h.toggle);
	assert.equal(h.fast(), true);
	for (const state of ["busy", "pending"] as const) {
		h[state](true);
		for (const action of ["model", "thinking", "fast"] as const) assert.equal((await applyFooterAction(action, h.pi, h.ctx, h.toggle)).ok, false);
		h[state](false);
	}
	assert.equal(h.mutations(), 1);
	h.scope([{ model: h.available[0] }]);
	assert.equal((await applyFooterAction("model", h.pi, h.ctx, h.toggle)).ok, false);
});

test("private socket accepts only the correct runtime, session and whitelisted actions; cleanup removes it", async () => {
	const server = new FooterControlServer();
	const actions: string[] = [];
	const endpoint = await server.start("session-a", async action => { actions.push(action); return { ok: true }; });
	assert.ok(endpoint);
	try {
		assert.equal((await stat(dirname(endpoint.socket))).mode & 0o777, 0o700);
		assert.equal((await stat(endpoint.socket)).mode & 0o777, 0o600);
		assert.deepEqual(await sendFooterControl(endpoint, "thinking"), { ok: true });
		for (const [target, action] of [
			[{ ...endpoint, owner: "old-owner" }, "model"],
			[{ ...endpoint, session: "session-b" }, "model"],
			[endpoint, "send-message"],
		] as const) assert.equal((await sendFooterControl(target, action)).ok, false);
		assert.deepEqual(actions, ["thinking"]);
		const result = await promisify(execFile)(endpoint.node, [endpoint.client, endpoint.socket, endpoint.owner, endpoint.session, "fast"]);
		assert.deepEqual(JSON.parse(result.stdout), { ok: true });
		assert.deepEqual(actions, ["thinking", "fast"]);
	} finally { await server.stop(); }
	await server.stop();
	await assert.rejects(stat(endpoint.socket), { code: "ENOENT" });
	assert.equal((await sendFooterControl(endpoint, "model")).ok, false);
});

test("concurrent clicks cannot race; server failures never return raw diagnostic secrets", async () => {
	const server = new FooterControlServer();
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const begun = new Promise<void>(resolve => { started = resolve; });
	const block = new Promise<void>(resolve => { release = resolve; });
	let calls = 0;
	const endpoint = await server.start("s", async () => {
		calls += 1;
		started?.();
		await block;
		throw new Error("secret raw error");
	});
	assert.ok(endpoint);
	try {
		const first = sendFooterControl(endpoint, "model");
		await begun;
		const second = await sendFooterControl(endpoint, "thinking");
		assert.equal(second.ok, false);
		assert.equal(calls, 1);
		release?.();
		assert.doesNotMatch(JSON.stringify(await first), /secret raw error/);
	} finally { release?.(); await server.stop(); }
});
