import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";
import { formatTimerRelative, formatTimerTime, registerTimersFeature, resolveTimerDeadline } from "./timers.ts";

type Params = { action: "set"; after: string; message: string } | { action: "list" } | { action: "cancel"; id: string };
type SavedTimer = { id: string; at: number; message: string };
type Entry = { type: "custom"; customType: string; data: { timers: SavedTimer[] } };
type TimerDetails = { now: string; timers: { id: string; at: string; message: string }[]; id?: string; at?: string };
type Result = { content: { type: string; text: string }[]; details: TimerDetails; structuredContent: TimerDetails };
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

test("formats local dates across midnight and daylight saving using the machine timezone", () => {
	const source = `import { formatTimerTime } from ${JSON.stringify(new URL("./timers.ts", import.meta.url).href)};
		for (const at of ["2026-11-09T23:39:00Z", "2026-07-01T00:00:00Z", "2026-09-26T13:59:00Z", "2026-09-26T14:00:00Z"])
			console.log(formatTimerTime(Date.parse(at)));`;
	const formatIn = (TZ: string) => execFileSync(process.execPath, ["--input-type=module", "-e", source], {
		env: { ...process.env, TZ }, encoding: "utf8",
	}).replace(/[\u00a0\u202f]/g, " ");
	const nz = formatIn("Pacific/Auckland");
	assert.match(nz, /Tue,? 10 Nov 2026.*12:39:00 pm NZDT/);
	assert.match(nz, /Wed,? 1 Jul 2026.*12:00:00 pm NZST/);
	assert.match(nz, /Sun,? 27 Sept 2026.*1:59:00 am NZST/);
	assert.match(nz, /Sun,? 27 Sept 2026.*3:00:00 am NZDT/);
	assert.match(formatIn("UTC"), /Mon,? 9 Nov 2026.*11:39:00 pm UTC/);
});

test("relative times cover seconds, minutes, hours, days and overdue deadlines", () => {
	for (const [seconds, expected] of [
		[30, "in 30 seconds"], [180, "in 3 minutes"], [7200, "in 2 hours"],
		[172800, "in 2 days"], [-180, "3 minutes ago"],
	] as const) {
		assert.equal(formatTimerRelative(NOW + seconds * 1000, NOW), expected);
	}
});

test("returns immediately, wakes once with follow-up delivery, and consumes the timer", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
	const h = harness();
	t.after(h.stop);
	const result = await h.call({ action: "set", after: "33m", message: "Check token expiry" });
	assert.ok(result.details.id);
	assert.equal(result.details.now, new Date(NOW).toISOString());
	assert.equal(result.details.at, new Date(NOW + 33 * 60_000).toISOString());
	assert.equal(result.details.timers[0].at, result.details.at);
	assert.deepEqual(result.structuredContent, result.details);
	assert.equal(result.content[0].text, `Timer set for ${formatTimerTime(NOW + 33 * 60_000)} · in 33 minutes\n${result.details.id} · Check token expiry`);
	const listed = await h.call({ action: "list" });
	assert.match(listed.content[0].text, /in 33 minutes/);
	assert.ok(listed.content[0].text.includes(formatTimerTime(NOW + 33 * 60_000)));
	assert.deepEqual(listed.structuredContent, listed.details);
	assert.equal(h.messages.length, 0);
	t.mock.timers.tick(33 * 60_000 - 1);
	assert.equal(h.messages.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].content, `Timer woke at ${formatTimerTime(NOW + 33 * 60_000)}:\n- ${result.details.id}, scheduled for ${formatTimerTime(NOW + 33 * 60_000)}: Check token expiry`);
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
	assert.ok(h.notifications[0].includes(formatTimerTime(NOW + 30_000)));
	assert.match(h.notifications[0], /in 30 seconds/);
	const cancelled = await h.call({ action: "cancel", id: result.details.id });
	assert.equal(cancelled.content[0].text, `Timer cancelled: ${result.details.id}\nNo pending timers.`);
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
	assert.ok(resumed.messages[0].content.startsWith(`Timer woke at ${formatTimerTime(NOW + 60_001)}:`));
	assert.ok(resumed.messages[0].content.includes(`scheduled for ${formatTimerTime(NOW + 30_000)}`));
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
