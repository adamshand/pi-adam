import { closeSync, chmodSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const RowSchema = Type.Object({ data: Type.String() });
const Instant = Type.Number({ minimum: 0, maximum: 8_640_000_000_000_000 });
const OwnerSchema = Type.Object({ host: Type.String(), pid: Type.Integer({ minimum: 1 }), startedAt: Instant });
const StateSchema = Type.Object({
	semanticRevision: Type.Optional(Type.Integer({ minimum: 0 })),
	version: Type.Literal(1), revision: Type.Integer({ minimum: 0 }),
	sessionId: Type.String(), cwd: Type.String(),
	coverage: Type.Optional(Type.Array(Type.Object({ start: Instant, end: Instant, idle: Type.Boolean() }))),
	intervals: Type.Array(Type.Object({ start: Instant, end: Instant })),
	active: Type.Union([Type.Null(), Type.Object({ start: Instant, observedAt: Instant, owner: OwnerSchema })]),
});
export type TrackingOwner = Static<typeof OwnerSchema>;
export type TrackingState = Static<typeof StateSchema>;

function parseState(value: string): TrackingState {
	const parsed: unknown = JSON.parse(value);
	if (!Check(StateSchema, parsed)) throw new Error("Invalid tracking record; retained unchanged.");
	let end = 0;
	for (const interval of parsed.intervals) {
		if (interval.start < end || interval.end < interval.start) throw new Error("Invalid tracking intervals; retained unchanged.");
		end = interval.end;
	}
	if (parsed.active && (parsed.active.start < end || parsed.active.observedAt < parsed.active.start)) {
		throw new Error("Invalid active tracking interval; retained unchanged.");
	}
	let coveredEnd = 0;
	for (const span of parsed.coverage ?? []) {
		if (span.start < coveredEnd || span.end < span.start) throw new Error("Invalid focus coverage; retained unchanged.");
		coveredEnd = span.end;
	}
	return parsed;
}

/** SQLite serializes cross-process starts and makes interrupted writes recoverable. */
export class TrackingStore {
	private readonly db: DatabaseSync;
	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const fd = openSync(path, "a", 0o600);
		closeSync(fd);
		chmodSync(path, 0o600);
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA busy_timeout = 2000;
			CREATE TABLE IF NOT EXISTS trackers (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS tracking_archives (session_id TEXT NOT NULL, cleared_at INTEGER NOT NULL, data TEXT NOT NULL);`);
	}
	get(sessionId: string): TrackingState | undefined {
		const row = this.db.prepare("SELECT data FROM trackers WHERE session_id = ?").get(sessionId);
		if (!row) return undefined;
		if (!Check(RowSchema, row)) throw new Error("Invalid tracking storage.");
		const state = parseState(row.data);
		if (state.sessionId !== sessionId) throw new Error("Tracking session identity mismatch.");
		return state;
	}
	list(): TrackingState[] {
		return this.db.prepare("SELECT data FROM trackers").all().map(row => {
			if (!Check(RowSchema, row)) throw new Error("Invalid tracking storage.");
			return parseState(row.data);
		});
	}
	update(sessionId: string, expectedRevision: number | undefined | { semanticRevision: number }, change: (current: TrackingState | undefined) => TrackingState, archiveAt?: number, telemetry = false): TrackingState {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const current = this.get(sessionId);
			if (!(expectedRevision instanceof Object ? !!current && (current.semanticRevision ?? current.revision) === expectedRevision.semanticRevision : current?.revision === expectedRevision)) throw new Error("Tracking changed while you were reviewing it; run /track again.");
			if (archiveAt !== undefined && current) {
				const archived = structuredClone(current);
				if (archived.active) {
					if (archiveAt < archived.active.observedAt) throw new Error("Clock moved backwards; cannot clear tracking yet.");
					archived.intervals.push({ start: archived.active.start, end: archiveAt });
					archived.active = null;
				}
				this.db.prepare("INSERT INTO tracking_archives VALUES (?, ?, ?)").run(sessionId, archiveAt, JSON.stringify(archived));
			}
			const semanticRevision = current ? current.semanticRevision ?? current.revision : -1;
			const state = change(current);
			state.semanticRevision = telemetry ? Math.max(0, semanticRevision) : semanticRevision + 1;
			state.revision = (current?.revision ?? -1) + 1;
			if (state.sessionId !== sessionId) throw new Error("Tracking session identity mismatch.");
			parseState(JSON.stringify(state));
			this.db.prepare("INSERT INTO trackers VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data").run(sessionId, JSON.stringify(state));
			this.db.exec("COMMIT");
			return state;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	close(): void { this.db.close(); }
}

export function isTrackingOwner(owner: TrackingOwner, current: TrackingOwner): boolean {
	return owner.host === current.host && owner.pid === current.pid && owner.startedAt === current.startedAt;
}

export function trackedMilliseconds(state: TrackingState, at: number, includeActive: boolean): number {
	return state.intervals.reduce((total, interval) => total + interval.end - interval.start, 0)
		+ (includeActive && state.active ? Math.max(0, at - state.active.start) : 0);
}

export function formatTrackedTime(milliseconds: number): string {
	const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
	return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** Clip confirmed focus spans to included billable intervals, including reviewed crash ends. */
export function trackingBreakdown(state: TrackingState, at: number, includeActive: boolean) {
	const intervals = [...state.intervals];
	if (includeActive && state.active) intervals.push({ start: state.active.start, end: at });
	let known = 0;
	let idleMilliseconds = 0;
	for (const span of state.coverage ?? []) {
		for (const interval of intervals) {
			const duration = Math.max(0, Math.min(span.end, interval.end) - Math.max(span.start, interval.start));
			known += duration;
			if (span.idle) idleMilliseconds += duration;
		}
	}
	return { idleMilliseconds, unknownMilliseconds: Math.max(0, trackedMilliseconds(state, at, includeActive) - known) };
}
