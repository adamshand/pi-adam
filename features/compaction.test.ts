import assert from "node:assert/strict";
import test from "node:test";
import type { CompactOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCompactionFeature } from "./compaction.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";

function harness() {
	type Event = { outcome?: string; messages?: unknown[] };
	type Result = { messages: { content: string }[] } | undefined;
	const handlers = new Map<string, (event: Event, ctx: ExtensionContext) => Result>();
	let tool: { name: string; description: string; execute(): Promise<{ content: { type: string; text: string }[] }> } | undefined;
	const calls: (CompactOptions | undefined)[] = [];
	const notifications: string[] = [];
	let pending = false;
	let percent: number | null | undefined = 65;
	const ctx = createTestExtensionContext({
		getContextUsage: () => percent === undefined ? undefined : { percent },
		hasPendingMessages: () => pending,
		compact: (options?: CompactOptions) => { calls.push(options); },
		hasUI: true,
		ui: { notify: (text: string) => { notifications.push(text); } },
	});
	registerCompactionFeature(createTestExtensionApi({
		on: (name: string, handler: (event: Event, ctx: ExtensionContext) => Result) => { handlers.set(name, handler); },
		registerTool: (value: NonNullable<typeof tool>) => { tool = value; },
	}));
	assert.ok(tool);
	return {
		tool, calls, notifications,
		emit: (name: string, event: Event = {}) => handlers.get(name)?.(event, ctx),
		setPending: (value: boolean) => { pending = value; },
		setPercent: (value: typeof percent) => { percent = value; },
	};
}

test("request returns before compaction; repeated requests compact once at completion", async () => {
	const h = harness();
	assert.equal(h.tool.name, "request_compaction");
	assert.match(h.tool.description, /over 50%/);
	h.emit("agent_before_settle", { outcome: "completed" });
	assert.equal(h.calls.length, 0);
	await h.tool.execute();
	await h.tool.execute();
	assert.equal(h.calls.length, 0);
	h.emit("agent_before_settle", { outcome: "completed" });
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0]?.customInstructions, undefined);
	h.emit("agent_before_settle", { outcome: "completed" });
	assert.equal(h.calls.length, 1);
	h.calls[0]?.onError?.(new Error("provider unavailable"));
	assert.deepEqual(h.notifications, ["Requested compaction failed: provider unavailable"]);
});

test("queued work delays compaction without losing the request", async () => {
	const h = harness();
	await h.tool.execute();
	h.setPending(true);
	h.emit("agent_before_settle", { outcome: "completed" });
	assert.equal(h.calls.length, 0);
	h.setPending(false);
	h.emit("agent_before_settle", { outcome: "completed" });
	assert.equal(h.calls.length, 1);
});

test("session changes, existing compaction, and interrupted runs clear requests", async () => {
	for (const name of ["session_start", "session_shutdown", "session_compact", "aborted", "error"]) {
		const h = harness();
		await h.tool.execute();
		if (name === "aborted" || name === "error") h.emit("agent_before_settle", { outcome: name });
		else h.emit(name);
		h.emit("agent_before_settle", { outcome: "completed" });
		assert.equal(h.calls.length, 0, name);
	}
});

test("context usage is current, request-local, and handles unknown estimates", () => {
	const h = harness();
	const messages = [{ content: "Original conversation" }];
	assert.equal(h.emit("context", { messages })?.messages.at(-1)?.content, "Current context usage: 65.0%.");
	h.setPercent(25);
	assert.equal(h.emit("context", { messages })?.messages.at(-1)?.content, "Current context usage: 25.0%.");
	for (const value of [null, undefined]) {
		h.setPercent(value);
		assert.equal(h.emit("context", { messages })?.messages.at(-1)?.content, "Current context usage is unknown.");
	}
	assert.equal(messages.length, 1);
});
