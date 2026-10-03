import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";
import { registerTimersFeature, resolveTimerDeadline } from "./timers.ts";

type Params = { action: "set"; after: string; message: string } | { action: "list" } | { action: "cancel"; id: string };
type SavedTimer = { id: string; at: number; message: string };
type Entry = { type: "custom"; customType: string; data: { timers: SavedTimer[] } };
type Result = { details: { timers: { id: string; at: string; message: string }[]; id?: string } };
type Tool = { execute(id: string, params: Params, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<Result> };

function harness(entries: Entry[] = [], session = "one") {
	const handlers = new Map<string, (event: { reason: string }, ctx: ExtensionContext) => void>();
	let tool: Tool | undefined;
	let command: { handler(args: string, ctx: ExtensionContext): Promise<void> } | undefined;
	const messages: { content: string }[] = [];
	const options: { triggerTurn: boolean; deliverAs: string }[] = [];
	const notifications: string[] = [];
	const ctx = createTestExtensionContext({
		sessionManager: { getSessionId: () => session, getEntries: () => entries },
		ui: { notify: (message: string) => notifications.push(message) },
	});
	registerTimersFeature(createTestExtensionApi({
		on: (name: string, handler: (event: { reason: string }, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		registerTool: (value: Tool) => { tool = value; },
		registerCommand: (_name: string, value: NonNullable<typeof command>) => { command = value; },
		appendEntry: (customType: string, data: Entry["data"]) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: { content: string }, delivery: { triggerTurn: boolean; deliverAs: string }) => {
			messages.push(message);
			options.push(delivery);
		},
	}));
	const start = () => handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const stop = () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
	const call = async (params: Params) => {
		assert.ok(tool);
		return tool.execute("call", params, undefined, undefined, ctx);
	};
	const runCommand = async (args: string) => {
		assert.ok(command);
		await command.handler(args, ctx);
	};
	start();
	return { entries, messages, options, notifications, call, runCommand, start, stop };
}

const NOW = Date.parse("2026-10-03T10:00:00Z");

test("resolves durations, UTC and NZDT instants without guessing a date", () => {
	assert.equal(resolveTimerDeadline("33m", undefined, NOW), NOW + 33 * 60_000);
	assert.equal(resolveTimerDeadline(undefined, "2026-10-03T11:13:00Z", NOW), NOW + 73 * 60_000);
	assert.equal(resolveTimerDeadline(undefined, "2026-10-03T23:33:00+13:00", NOW), NOW + 33 * 60_000);
	for (const after of ["0m", "-1s", "33 minutes", "Infinityh"]) {
		assert.throws(() => resolveTimerDeadline(after, undefined, NOW));
	}
	for (const at of ["11:13 UTC", "2026-10-03T11:13:00", "2026-02-30T11:00:00Z", "2026-10-03T24:00:00Z", "2026-10-03T09:00:00Z"]) {
		assert.throws(() => resolveTimerDeadline(undefined, at, NOW));
	}
});

test("returns immediately, wakes once with follow-up delivery, and consumes the timer", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
	const h = harness();
	t.after(h.stop);
	const result = await h.call({ action: "set", after: "33m", message: "Check token expiry" });
	assert.ok(result.details.id);
	assert.equal(h.messages.length, 0);
	t.mock.timers.tick(33 * 60_000 - 1);
	assert.equal(h.messages.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.messages.length, 1);
	assert.match(h.messages[0].content, /Check token expiry/);
	assert.deepEqual(h.options, [{ triggerTurn: true, deliverAs: "followUp" }]);
	assert.equal((await h.call({ action: "list" })).details.timers.length, 0);
	t.mock.timers.tick(60_000);
	assert.equal(h.messages.length, 1);
});

test("cancellation and /timers never trigger model calls", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
	const h = harness();
	t.after(h.stop);
	const result = await h.call({ action: "set", after: "30s", message: "Resume" });
	assert.ok(result.details.id);
	await h.runCommand("");
	assert.match(h.notifications[0], /Resume/);
	await h.call({ action: "cancel", id: result.details.id });
	await assert.rejects(h.call({ action: "cancel", id: result.details.id }));
	t.mock.timers.tick(60_000);
	assert.equal(h.messages.length, 0);
	await h.call({ action: "set", after: "1h", message: "Other" });
	await h.runCommand("cancel all");
	assert.equal((await h.call({ action: "list" })).details.timers.length, 0);
});

test("reload restores deadlines; overdue reminders fire once on resume", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
	const first = harness();
	await first.call({ action: "set", after: "30s", message: "Resume expiry test" });
	first.stop();
	t.mock.timers.tick(60_000);
	assert.equal(first.messages.length, 0);
	const resumed = harness(first.entries);
	t.after(resumed.stop);
	t.mock.timers.tick(1);
	assert.equal(resumed.messages.length, 1);
	resumed.stop();
	const again = harness(first.entries);
	t.after(again.stop);
	t.mock.timers.tick(1);
	assert.equal(again.messages.length, 0);
});

test("shutdown prevents callbacks from leaking into another session", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
	const first = harness();
	await first.call({ action: "set", after: "1s", message: "Only session one" });
	first.stop();
	const other = harness([], "two");
	t.after(other.stop);
	t.mock.timers.tick(1000);
	assert.equal(first.messages.length, 0);
	assert.equal(other.messages.length, 0);
});

test("long timers use bounded timeouts instead of firing immediately", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
	const h = harness();
	t.after(h.stop);
	await h.call({ action: "set", after: "30d", message: "Later" });
	t.mock.timers.tick(2_147_483_647);
	assert.equal(h.messages.length, 0);
	t.mock.timers.tick(30 * 86_400_000 - 2_147_483_647);
	assert.equal(h.messages.length, 1);
});
