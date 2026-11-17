import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";
import { parseTrackingEnd, registerTimeTrackingFeature, type TrackingStamp } from "./time-tracking.ts";
import { currentTrackingOwner, trackingOwnerAlive } from "./time-tracking-process.ts";
import { TrackingStore, formatTrackedTime, trackedMilliseconds, type TrackingOwner, type TrackingState } from "./time-tracking-store.ts";

const BASE = Date.parse("2026-11-13T00:00:00Z");
const owner: TrackingOwner = { host: "test-host", pid: 1234, startedAt: BASE - 1000 };
function storage(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-track-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "private", "tracking.sqlite");
}
type TestEvent = { reason?: string; message?: { role: string }; kind?: string };
function harness(t: TestContext, path: string, config: { owner?: TrackingOwner; alive?: boolean; liveness?: (owner: TrackingOwner) => boolean; realOwner?: boolean; sessionId?: string; reason?: string } = {}) {
	const handlers = new Map<string, (event: TestEvent, ctx: ExtensionContext) => void>();
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let clock = BASE;
	let sessionId = config.sessionId ?? "session-one";
	let mode = "tui";
	let saved = true;
	let closed = false;
	let select: (options: string[]) => Promise<string | undefined> = async options => options[0];
	let confirm: () => Promise<boolean> = async () => true;
	let input: string | undefined;
	const notices: { text: string; level: string }[] = [];
	const ctx = createTestExtensionContext({
		get mode() { return mode; }, cwd: "/client/project",
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => saved ? `/sessions/${sessionId}.jsonl` : undefined },
		ui: {
			notify: (text: string, level: string) => notices.push({ text, level }),
			select: (_title: string, options: string[]) => select(options),
			confirm: () => confirm(), input: async () => input,
		},
	});
	const stamp = registerTimeTrackingFeature(createTestExtensionApi({
		on: (name: string, handler: (event: TestEvent, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		registerCommand: (name: string, spec: { handler: NonNullable<typeof command> }) => { assert.equal(name, "track"); command = spec.handler; },
	}), { path, now: () => clock, owner: config.realOwner ? undefined : config.owner ?? owner, ownerAlive: config.liveness ?? (() => config.alive ?? false) });
	const event = (name: string, value: TestEvent = {}) => handlers.get(name)!(value, ctx);
	event("session_start", { reason: config.reason ?? "startup" });
	t.after(() => { if (!closed) event("session_shutdown", { reason: "reload" }); });
	return {
		stamp: () => stamp(clock), focus: stamp.focus, subscription: stamp.focusSubscription, onFocusRequest: stamp.onFocusRequest, notices, event,
		track: (args = "") => command!(args, ctx),
		at: (at: number) => { clock = at; },
		select: (fn: typeof select) => { select = fn; },
		confirm: (fn: typeof confirm) => { confirm = fn; },
		input: (text: string | undefined) => { input = text; },
		shutdown: (reason = "quit") => { event("session_shutdown", { reason }); closed = true; },
		switchTo: (id: string) => { event("session_shutdown", { reason: "new" }); sessionId = id; event("session_start", { reason: "new" }); },
		rpc: () => { mode = "rpc"; }, ephemeral: () => { saved = false; },
	};
}
const empty = (id = "session-one"): TrackingState => ({ version: 1, revision: 0, sessionId: id, cwd: "/client/project", intervals: [], active: null });
function persisted(path: string, id = "session-one") {
	const db = new TrackingStore(path);
	try { return db.get(id); } finally { db.close(); }
}

test("track accumulates wall time, repeated starts are idempotent, pause excludes gaps", async t => {
	const path = storage(t);
	const h = harness(t, path);
	assert.equal(h.stamp(), undefined);
	await h.track();
	h.at(BASE + 72 * 60_000);
	assertStamp(h.stamp(), { status: "tracking", milliseconds: 72 * 60_000 });
	await h.track();
	assert.equal(persisted(path)!.active!.start, BASE);
	await h.track("pause");
	h.at(BASE + 120 * 60_000);
	assertStamp(h.stamp(), { status: "paused", milliseconds: 72 * 60_000 });
	await h.track();
	h.at(BASE + 121 * 60_000);
	await h.track("pause");
	assert.equal(h.stamp()!.milliseconds, 73 * 60_000);
	await h.track("status");
	assert.match(h.notices.at(-1)!.text, /paused: 1h 13m/);
	assert.equal(persisted(path)!.intervals.length, 2);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
});

test("reload preserves running interval; quit pauses; new/fork session has no inherited billable time", async t => {
	const path = storage(t);
	const first = harness(t, path);
	await first.track();
	first.at(BASE + 60_000);
	first.shutdown("reload");
	const reloaded = harness(t, path, { reason: "reload" });
	reloaded.at(BASE + 120_000);
	assert.equal(reloaded.stamp()!.status, "tracking");
	reloaded.shutdown();
	const resumed = harness(t, path);
	resumed.at(BASE + 180_000);
	assertStamp(resumed.stamp(), { status: "paused", milliseconds: 120_000 });
	await resumed.track();
	resumed.at(BASE + 240_000);
	resumed.switchTo("forked-session");
	assert.equal(resumed.stamp(), undefined);
	assert.equal(trackedMilliseconds(persisted(path)!, BASE, false), 180_000);
});

test("interrupted intervals are not silently billed overnight and need a chosen end", async t => {
	const path = storage(t);
	const first = harness(t, path);
	await first.track();
	first.at(BASE + 60_000);
	first.event("agent_settled");
	first.shutdown("reload");
	const resumed = harness(t, path, { owner: { ...owner, pid: 999 } });
	resumed.at(BASE + 86_400_000);
	assertStamp(resumed.stamp(), { status: "review needed", milliseconds: 0 });
	resumed.select(async () => undefined);
	await resumed.track();
	assert.equal(resumed.stamp()!.status, "review needed");
	resumed.select(async choices => choices[0]);
	await resumed.track("pause");
	assertStamp(resumed.stamp(), { status: "paused", milliseconds: 60_000 });
	assert.equal(persisted(path)!.active, null);
});

test("interruption recovery supports a custom end or explicit discard", async t => {
	for (const discard of [false, true]) {
		const path = storage(t);
		const db = new TrackingStore(path);
		db.update("session-one", undefined, () => ({ ...empty(), active: { start: BASE, observedAt: BASE + 60_000, owner } }));
		db.close();
		const h = harness(t, path, { owner: { ...owner, pid: 999 } });
		h.at(BASE + 120_000);
		h.select(async choices => choices[discard ? 2 : 1]);
		h.input(new Date(BASE + 90_000).toISOString());
		await h.track("pause");
		assert.equal(h.stamp()!.milliseconds, discard ? 0 : 90_000);
	}
});

test("clear confirms and archives the closed interval before resetting, never deletes billing history", async t => {
	const path = storage(t);
	const h = harness(t, path);
	await h.track();
	h.at(BASE + 60_000);
	h.confirm(async () => false);
	await h.track("clear");
	assert.equal(h.stamp()!.status, "tracking");
	h.confirm(async () => true);
	await h.track("clear");
	assert.equal(h.stamp(), undefined);
	assert.deepEqual(persisted(path)!.intervals, []);
	const db = new DatabaseSync(path);
	try {
		const row = db.prepare("SELECT data FROM tracking_archives").get();
		assert.ok(row);
		assert.deepEqual(JSON.parse(String(row.data)), { ...empty(), semanticRevision: 0, active: null, intervals: [{ start: BASE, end: BASE + 60_000 }] });
	} finally { db.close(); }
});

test("other session trackers warn, while duplicate live owners cannot modify the same tracker", async t => {
	const path = storage(t);
	const first = harness(t, path);
	await first.track();
	const second = harness(t, path, { owner: { ...owner, pid: 999 }, alive: true, sessionId: "session-two" });
	await second.track();
	assert.ok(second.notices.some(n => n.level === "warning" && n.text.includes("Overlapping")));
	const duplicate = harness(t, path, { owner: { ...owner, pid: 998 }, alive: true });
	await duplicate.track("pause");
	assert.match(duplicate.notices.at(-1)!.text, /another live or unverifiable Pi process/);
	assert.equal(persisted(path)!.active!.owner.pid, owner.pid);
});

test("reused PIDs are not mistaken for the original tracker owner", async t => {
	const path = storage(t);
	const first = harness(t, path);
	await first.track();
	first.at(BASE + 60_000);
	first.shutdown("reload");
	const liveness = (saved: TrackingOwner) => trackingOwnerAlive(saved, owner.host, () => ({ state: "running", startedAt: owner.startedAt + 1000 }));
	assert.equal(liveness(owner), false);
	const resumed = harness(t, path, { owner: { ...owner, pid: 999 }, liveness });
	resumed.at(BASE + 120_000);
	await resumed.track("pause");
	assertStamp(resumed.stamp(), { status: "paused", milliseconds: 60_000 });
	assert.equal(trackingOwnerAlive(owner, owner.host, () => ({ state: "unknown" })), true);
});

test("OS process identity remains stable through wall-clock changes and reload", async t => {
	const path = storage(t);
	const identity = currentTrackingOwner();
	const first = harness(t, path, { realOwner: true });
	await first.track();
	first.shutdown("reload");
	const actualNow = Date.now();
	t.mock.method(Date, "now", () => actualNow + 60_000);
	assert.deepEqual(currentTrackingOwner(), identity);
	const reloaded = harness(t, path, { realOwner: true, reason: "reload" });
	reloaded.at(BASE + 60_000);
	assertStamp(reloaded.stamp(), { status: "tracking", milliseconds: 60_000 });
});

test("a second session viewer refreshes totals before new completion snapshots", async t => {
	const path = storage(t);
	const viewer = harness(t, path, { owner: { ...owner, pid: 999 }, alive: true });
	const first = harness(t, path);
	await first.track();
	assert.equal(viewer.stamp()!.status, "tracking elsewhere");
	first.at(BASE + 60_000);
	await first.track("pause");
	viewer.event("agent_settled");
	assertStamp(viewer.stamp(), { status: "paused", milliseconds: 60_000 });
	await first.track("clear");
	assert.equal(viewer.stamp(), undefined);
});

test("async dialogs cannot clear a new session or overwrite a changed record", async t => {
	const path = storage(t);
	const h = harness(t, path);
	await h.track();
	let decide: ((value: boolean) => void) | undefined;
	h.confirm(() => new Promise(resolve => { decide = resolve; }));
	const clearing = h.track("clear");
	h.switchTo("new-session");
	assert.ok(decide);
	decide(true);
	await clearing;
	assert.equal(persisted(path, "new-session"), undefined);
	assert.equal(persisted(path)!.intervals.length, 1);

	await h.track();
	const anotherClear = h.track("clear");
	h.at(BASE + 1000);
	const other = new TrackingStore(path);
	const current = other.get("new-session")!;
	other.update("new-session", current.revision, value => ({ ...value!, cwd: "/changed" }));
	other.close();
	decide(true);
	await anotherClear;
	assert.match(h.notices.at(-1)!.text, /changed while you were reviewing/);
	assert.ok(persisted(path, "new-session")!.active);
});

test("clock rollback and malformed storage fail visibly without resetting prior intervals", async t => {
	const path = storage(t);
	const h = harness(t, path);
	await h.track();
	h.at(BASE - 1);
	await h.track("pause");
	assert.equal(h.stamp()!.status, "tracking error");
	assert.equal(persisted(path)!.active!.start, BASE);
	const db = new DatabaseSync(path);
	try { db.prepare("UPDATE trackers SET data = ?").run("corrupt-record"); } finally { db.close(); }
	await h.track("clear");
	assert.ok(h.notices.some(n => n.level === "error"));
	const inspection = new DatabaseSync(path);
	try { assert.equal(inspection.prepare("SELECT data FROM trackers").get()!.data, "corrupt-record"); } finally { inspection.close(); }
});

test("non-interactive and ephemeral sessions cannot start tracking", async t => {
	for (const kind of ["rpc", "ephemeral"] as const) {
		const h = harness(t, storage(t));
		h[kind]();
		await h.track();
		assert.equal(h.stamp(), undefined);
		assert.match(h.notices.at(-1)!.text, /interactive, saved/);
	}
});

test("store revision checks and invalid transitions roll back atomically", t => {
	const path = storage(t);
	const first = new TrackingStore(path);
	const second = new TrackingStore(path);
	t.after(() => { first.close(); second.close(); });
	first.update("session-one", undefined, () => empty());
	assert.throws(() => second.update("session-one", undefined, () => empty()), /changed/);
	assert.throws(() => second.update("session-one", 0, current => ({ ...current!, intervals: [{ start: 200, end: 100 }] }), BASE), /Invalid/);
	assert.equal(first.get("session-one")!.revision, 0);
	const db = new DatabaseSync(path);
	try { assert.equal(db.prepare("SELECT count(*) AS count FROM tracking_archives").get()!.count, 0); } finally { db.close(); }
});

test("time formatting and explicit end validation do not round billing totals", () => {
	assert.equal(formatTrackedTime(72 * 60_000 + 59_999), "1h 12m");
	assert.equal(formatTrackedTime(59_999), "0m");
	assert.equal(parseTrackingEnd("2026-11-13T13:01:00+13:00", BASE, BASE + 120_000), BASE + 60_000);
	for (const text of ["2026-11-13T00:01:00", "2026-02-30T00:00:00Z", "2026-11-13T24:00:00Z", "2026-11-13T00:03:00Z"]) {
		assert.throws(() => parseTrackingEnd(text, BASE, BASE + 120_000));
	}
});

function assertStamp(actual: TrackingStamp | undefined, expected: TrackingStamp): void {
	assert.deepEqual(actual, { ...expected, idleMilliseconds: 0, unknownMilliseconds: expected.milliseconds });
}

test("confirmed focus spans intersect waiting, tools work while away, and tails stay unknown", async t => {
	const path = storage(t);
	const h = harness(t, path);
	await h.track();
	h.at(BASE + 1000); h.event("before_agent_start");
	h.at(BASE + 3000); h.event("agent_settled");
	h.at(BASE + 4000);
	h.focus({ providerStartedAt: 0, provider: "app", sequence: 1, start: BASE, end: BASE + 4000, focused: false });
	assert.deepEqual(h.stamp(), { status: "tracking", milliseconds: 4000, idleMilliseconds: 2000, unknownMilliseconds: 0 });
	h.at(BASE + 5000); h.event("agent_start");
	h.at(BASE + 6000); h.event("ui_prompt_start", { kind: "select" });
	h.at(BASE + 7000); h.event("ui_prompt_end");
	h.at(BASE + 8000); h.event("agent_settled");
	h.focus({ providerStartedAt: 0, provider: "app", sequence: 2, start: BASE + 4000, end: BASE + 8000, focused: false });
	assert.equal(h.stamp()!.idleMilliseconds, 4000);
	h.at(BASE + 9000);
	h.focus({ providerStartedAt: 0, provider: "app", sequence: 3, start: BASE + 8000, end: BASE + 9000, focused: true });
	assert.equal(h.stamp()!.idleMilliseconds, 4000);
	h.at(BASE + 10000); await h.track("pause");
	assert.equal(h.stamp()!.unknownMilliseconds, 1000);
	h.at(BASE + 20000);
	assert.equal(h.stamp()!.idleMilliseconds, 4000);
	await h.track();
	h.at(BASE + 21000);
	h.focus({ providerStartedAt: 0, provider: "app", sequence: 4, start: BASE + 9000, end: BASE + 21000, focused: false });
	assert.equal(h.stamp()!.idleMilliseconds, 6000); // excludes paused gap
	assert.equal(h.stamp()!.milliseconds, 11000);
	await h.track("clear");
	assert.equal(h.stamp(), undefined);
	const db = new DatabaseSync(path);
	try { assert.ok(JSON.parse(String(db.prepare("SELECT data FROM tracking_archives").get()!.data)).coverage.length); }
	finally { db.close(); }
});

test("reload and crash recovery retain confirmed spans but never extrapolate focus", async t => {
	const path = storage(t);
	const h = harness(t, path);
	await h.track();
	h.at(BASE + 1000);
	h.focus({ providerStartedAt: 0, provider: "app", sequence: 1, start: BASE, end: BASE + 1000, focused: false });
	h.at(BASE + 2000); h.shutdown("reload");
	const reloaded = harness(t, path, { reason: "reload" });
	reloaded.at(BASE + 3000);
	assert.equal(reloaded.stamp()!.idleMilliseconds, 1000);
	assert.equal(reloaded.stamp()!.unknownMilliseconds, 2000);
	reloaded.shutdown("reload");
	const recovered = harness(t, path, { owner: { ...owner, pid: 999 } });
	recovered.at(BASE + 10000);
	assert.equal(recovered.stamp()!.idleMilliseconds, 0);
	recovered.select(async choices => choices[1]);
	recovered.input(new Date(BASE + 500).toISOString());
	await recovered.track("pause");
	assert.equal(recovered.stamp()!.idleMilliseconds, 500);
	assert.equal(recovered.stamp()!.milliseconds, 500);
});

test("custom loaders and manual compaction are not mistaken for waiting prompts", async t => {
	const h = harness(t, storage(t));
	await h.track();
	h.event("agent_start");
	h.at(BASE + 1000); h.event("ui_prompt_start", { kind: "custom" });
	h.at(BASE + 2000); h.event("ui_prompt_end");
	h.at(BASE + 3000); h.event("agent_settled");
	h.at(BASE + 4000); h.event("session_before_compact");
	h.at(BASE + 5000); h.event("session_compact");
	h.at(BASE + 6000);
	h.focus({ providerStartedAt: 0, provider: "app", sequence: 1, start: BASE, end: BASE + 6000, focused: false });
	assert.equal(h.stamp()!.idleMilliseconds, 2000);
	assert.equal(h.stamp()!.unknownMilliseconds, 0);
});

test("clear accepts telemetry during deferred confirmation and archives latest coverage atomically", async t => {
	const path = storage(t);
	const h = harness(t, path);
	await h.track();
	let decide: ((value: boolean) => void) | undefined;
	h.confirm(() => new Promise(resolve => { decide = resolve; }));
	const clearing = h.track("clear");
	h.at(BASE + 1000);
	h.focus({ providerStartedAt: BASE, provider: "app", sequence: 1, start: BASE, end: BASE + 1000, focused: false });
	h.at(BASE + 2000); h.event("agent_settled");
	decide!(true); await clearing;
	assert.equal(h.stamp(), undefined);
	const db = new DatabaseSync(path);
	try {
		const archive = JSON.parse(String(db.prepare("SELECT data FROM tracking_archives").get()!.data));
		assert.deepEqual(archive.coverage, [{ start: BASE, end: BASE + 1000, idle: true }]);
		assert.deepEqual(archive.intervals, [{ start: BASE, end: BASE + 2000 }]);
	} finally { db.close(); }
});

test("subscriptions follow tracking and lifecycle checkpoints, but never telemetry", async t => {
	const path = storage(t);
	const h = harness(t, path);
	let requests = 0; h.onFocusRequest(() => requests++);
	assert.equal(h.subscription().focusSpans, false);
	await h.track(); assert.equal(h.subscription().focusSpans, true);
	const epoch = h.subscription().focusEpoch;
	h.at(BASE + 1000); h.event("agent_start");
	assert.ok(h.subscription().focusEpoch > epoch);
	const before = requests;
	h.at(BASE + 2000);
	h.focus({ providerStartedAt: BASE, provider: "app", sequence: 1, start: BASE, end: BASE + 2000, focused: false });
	assert.equal(requests, before);
	await h.track("pause"); assert.equal(h.subscription().focusSpans, false);
	const revision = persisted(path)!.revision;
	h.at(BASE + 3000);
	h.focus({ providerStartedAt: BASE, provider: "app", sequence: 2, start: BASE + 2000, end: BASE + 3000, focused: false });
	assert.equal(persisted(path)!.revision, revision);
	await h.track("clear"); const cleared = persisted(path);
	h.at(BASE + 4000);
	h.focus({ providerStartedAt: BASE, provider: "app", sequence: 3, start: BASE + 3000, end: BASE + 4000, focused: false });
	await h.track("clear"); assert.deepEqual(persisted(path), cleared);
});

test("provider restart and hot reload recover without Pi reload and reject retired deliveries", async t => {
	const h = harness(t, storage(t)); await h.track();
	const send = (provider: string, providerStartedAt: number, sequence: number, start: number, end: number) => {
		h.at(BASE + end); h.focus({ provider, providerStartedAt: BASE + providerStartedAt, sequence, start: BASE + start, end: BASE + end, focused: false });
	};
	send("app", 0, 1, 0, 1000);
	send("restart", 2000, 1, 2000, 3000);
	send("app", 0, 2, 3000, 4000);
	send("hot-reload", 4000, 1, 4000, 5000);
	send("restart", 2000, 2, 5000, 6000);
	send("hot-reload", 4000, 2, 5000, 7000);
	assert.equal(h.stamp()!.idleMilliseconds, 5000);
	assert.equal(h.stamp()!.unknownMilliseconds, 2000);
});

test("failed persistence does not consume a focus sequence", async t => {
	const path = storage(t); const h = harness(t, path); await h.track();
	const original = TrackingStore.prototype.update;
	let fail = true;
	t.mock.method(TrackingStore.prototype, "update", function (this: TrackingStore, ...args: Parameters<TrackingStore["update"]>) {
		if (fail) throw new Error("test write failure");
		return original.apply(this, args);
	});
	h.at(BASE + 1000);
	const span = { providerStartedAt: BASE, provider: "app", sequence: 1, start: BASE, end: BASE + 1000, focused: false };
	h.focus(span); assert.equal(persisted(path)!.coverage, undefined);
	fail = false; h.focus(span);
	assert.deepEqual(persisted(path)!.coverage, [{ start: BASE, end: BASE + 1000, idle: true }]);
});

test("old ledgers migrate on write and untracked focus or clear creates no record", async t => {
	const path = storage(t); const h = harness(t, path);
	h.at(BASE + 1000);
	h.focus({ providerStartedAt: BASE, provider: "app", sequence: 1, start: BASE, end: BASE + 1000, focused: false });
	await h.track("clear");
	assert.equal(existsSync(path), false);
	const store = new TrackingStore(path); store.close();
	const raw = new DatabaseSync(path);
	const old = { ...empty(), intervals: [{ start: BASE, end: BASE + 500 }] };
	raw.prepare("INSERT INTO trackers VALUES (?, ?)").run(old.sessionId, JSON.stringify(old)); raw.close();
	await h.track("status");
	assert.equal(h.stamp()!.unknownMilliseconds, 500);
	assert.equal(persisted(path)!.semanticRevision, undefined);
	await h.track("clear");
	assert.equal(persisted(path)!.semanticRevision, 1);
});
