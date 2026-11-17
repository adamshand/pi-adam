import { FocusCoverage, type FocusSpan } from "./time-tracking-focus.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { currentTrackingOwner, trackingOwnerAlive } from "./time-tracking-process.ts";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TrackingStore, formatTrackedTime, isTrackingOwner, trackedMilliseconds, trackingBreakdown, type TrackingOwner, type TrackingState } from "./time-tracking-store.ts";

export type TrackingStamp = { status: "tracking" | "paused" | "review needed" | "tracking elsewhere" | "tracking error"; milliseconds: number; idleMilliseconds?: number; unknownMilliseconds?: number };
type Options = { path?: string; now?: () => number; owner?: TrackingOwner; ownerAlive?: (owner: TrackingOwner) => boolean };

export function parseTrackingEnd(text: string, start: number, now: number): number {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw new Error("Use a full ISO date/time with seconds and timezone, e.g. 2026-11-13T15:30:00+13:00.");
	const calendar = new Date(`${text.slice(0, 10)}T00:00:00Z`);
	const end = Date.parse(text);
	if (!Number.isFinite(end) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== text.slice(0, 10)
		|| Number(text.slice(11, 13)) > 23 || Number(text.slice(14, 16)) > 59 || Number(text.slice(17, 19)) > 59 || end < start || end > now) {
		throw new Error("End time must be valid and between the interval's start and now.");
	}
	return end;
}

const localTime = (at: number) => new Date(at).toLocaleString(undefined, { timeZoneName: "short" });

export type TrackingFocus = {
	focus: (span: FocusSpan) => void;
	focusSubscription: () => { focusSpans: boolean; focusEpoch: number };
	onFocusRequest: (listener: () => void) => void;
};

export function registerTimeTrackingFeature(pi: ExtensionAPI, options: Options = {}): ((at: number) => TrackingStamp | undefined) & TrackingFocus {
	let coverage = new FocusCoverage();
	let focusEpoch = 0;
	let focusListener: (() => void) | undefined;
	const requestFocus = () => { focusEpoch++; focusListener?.(); };
	let currentContext: ExtensionContext | undefined;
	let working = false;
	let compacting = false;
	let prompting = false;
	let waiting = true;
	const now = options.now ?? Date.now;
	let owner = options.owner;
	const identity = () => owner ??= currentTrackingOwner();
	const alive = options.ownerAlive ?? trackingOwnerAlive;
	const path = options.path ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-adam", "time-tracking", "tracking.sqlite");
	let store: TrackingStore | undefined;
	let state: TrackingState | undefined;
	let sessionId: string | undefined;
	let owned = false;
	let failed = false;
	let commandBusy = false;
	let generation = 0;
	const database = () => store ??= new TrackingStore(path);
	const refresh = (): TrackingState | undefined => {
		state = sessionId && (store || existsSync(path)) ? database().get(sessionId) : undefined;
		if (!state?.active || !isTrackingOwner(state.active.owner, identity())) owned = false;
		return state;
	};
	const reportError = (ctx: ExtensionContext, message: string) => {
		failed = true;
		ctx.ui.notify(`Time tracking: ${message}`, "error");
	};
	const stamp = (at: number): TrackingStamp | undefined => {
		if (!state || (!state.active && state.intervals.length === 0)) return undefined;
		const status = failed ? "tracking error" : !state.active ? "paused" : owned ? "tracking"
			: alive(state.active.owner) && !isTrackingOwner(state.active.owner, identity()) ? "tracking elsewhere" : "review needed";
		return { status, milliseconds: trackedMilliseconds(state, at, owned && !failed), ...trackingBreakdown(state, at, owned && !failed) };
	};
	const checkpoint = (ctx: ExtensionContext, pause = false) => {
		if (!owned || !state?.active || !sessionId) return;
		try {
			const at = now();
			state = database().update(sessionId, state.revision, current => {
				if (!current?.active || !isTrackingOwner(current.active.owner, identity())) throw new Error("Tracker ownership changed.");
				if (at < current.active.observedAt) throw new Error("Clock moved backwards; review the interval before billing.");
				if (pause) {
					current.intervals.push({ start: current.active.start, end: at });
					current.active = null;
				} else current.active.observedAt = at;
				return current;
			}, undefined, !pause);
			failed = false;
			if (pause) owned = false;
			requestFocus();
		} catch (error) { reportError(ctx, error instanceof Error ? error.message : String(error)); }
	};

	pi.on("session_start", (event, ctx) => {
		generation++;
		currentContext = ctx;
		working = false;
		compacting = false;
		prompting = false;
		waiting = true;
		coverage.reset(now());
		state = undefined;
		owned = false;
		failed = false;
		sessionId = ctx.sessionManager.getSessionId();
		try {
			state = refresh();
			owned = event.reason === "reload" && !!state?.active && isTrackingOwner(state.active.owner, identity());
			if (state?.active && !owned) ctx.ui.notify("Time tracking needs review. Run /track status to inspect it, then /track to resolve the interrupted interval. No uncertain time is added to the total.", "warning");
		} catch (error) { reportError(ctx, error instanceof Error ? error.message : String(error)); }
	});
	const activity = (ctx: ExtensionContext) => {
		const next = (!working && !compacting) || prompting;
		if (waiting === next) return;
		waiting = next;
		coverage.waiting(now(), waiting);
		checkpoint(ctx);
	};
	pi.on("before_agent_start", (_event, ctx) => { working = true; activity(ctx); });
	pi.on("agent_start", (_event, ctx) => { working = true; activity(ctx); });
	pi.on("session_before_compact", (_event, ctx) => { compacting = true; activity(ctx); });
	pi.on("session_compact", (_event, ctx) => { compacting = false; activity(ctx); });
	pi.on("session_compact_failed", (_event, ctx) => { compacting = false; activity(ctx); });
	pi.on("ui_prompt_start", (event, ctx) => {
		// Custom screens can be non-blocking loaders; do not infer waiting from those.
		if (event.kind !== "custom") { prompting = true; activity(ctx); }
	});
	pi.on("ui_prompt_end", (_event, ctx) => { prompting = false; activity(ctx); });
	pi.on("agent_settled", (_event, ctx) => {
		working = false;
		compacting = false;
		waiting = true;
		coverage.waiting(now(), true);
		try { refresh(); checkpoint(ctx); }
		catch (error) { reportError(ctx, error instanceof Error ? error.message : String(error)); }
	});
	pi.on("message_end", (event, ctx) => { if (event.message.role === "user") checkpoint(ctx); });
	pi.on("session_shutdown", (event, ctx) => {
		checkpoint(ctx, event.reason !== "reload");
		generation++;
		owned = false;
		currentContext = undefined;
		sessionId = undefined;
		store?.close();
		store = undefined;
	});

	async function resolveInterrupted(ctx: ExtensionContext, expectedGeneration: number): Promise<boolean> {
		const snapshot = state;
		if (!snapshot?.active || owned) return true;
		if (!isTrackingOwner(snapshot.active.owner, identity()) && alive(snapshot.active.owner)) throw new Error("This session is tracking in another live or unverifiable Pi process. Pause it there first.");
		const active = snapshot.active;
		const last = `End at last observed time: ${localTime(active.observedAt)}`;
		const choice = await ctx.ui.select(`Interrupted tracking from ${localTime(active.start)} — choose the billable end`, [last, "Enter an end time", "Discard this interrupted interval"]);
		if (!choice || generation !== expectedGeneration) return false;
		let end = active.observedAt;
		if (choice === "Enter an end time") {
			const text = await ctx.ui.input("Interval end (ISO date/time with timezone)", new Date(active.observedAt).toISOString());
			if (text === undefined || generation !== expectedGeneration) return false;
			end = parseTrackingEnd(text.trim(), active.start, now());
		} else if (choice === "Discard this interrupted interval") end = active.start;
		if (end > now()) throw new Error("Recorded time is in the future; correct your clock before resolving tracking.");
		state = database().update(snapshot.sessionId, snapshot.revision, current => {
			if (!current?.active) throw new Error("Interrupted interval changed.");
			current.intervals.push({ start: active.start, end });
			current.active = null;
			return current;
		});
		failed = false;
		return true;
	}

	function statusText(): string {
		if (!state) return "No tracked time. /track starts tracking.";
		const summary = stamp(now());
		const lines = [`${summary?.status ?? "paused"}: ${formatTrackedTime(summary?.milliseconds ?? 0)} (${summary?.milliseconds ?? 0}ms)`,
			`Confirmed idle: ${formatTrackedTime(summary?.idleMilliseconds ?? 0)} (${summary?.idleMilliseconds ?? 0}ms); unknown focus: ${formatTrackedTime(summary?.unknownMilliseconds ?? 0)} (${summary?.unknownMilliseconds ?? 0}ms). Unconfirmed focus tails remain unknown until a focus transition or Pi checkpoint.`];
		for (const interval of state.intervals) lines.push(`${localTime(interval.start)} → ${localTime(interval.end)} · ${formatTrackedTime(interval.end - interval.start)} (${(interval.end - interval.start) / 1000}s)`);
		if (state.active) lines.push(`Open interval: ${localTime(state.active.start)}; last observed ${localTime(state.active.observedAt)}${owned ? "" : " (not included until reviewed)"}`);
		lines.push(`Ledger: ${path}`);
		return lines.join("\n");
	}

	pi.registerCommand("track", {
		description: "Start/resume billable time, or /track pause|clear|status",
		async handler(args, ctx) {
			if (ctx.mode !== "tui" || !ctx.sessionManager.getSessionFile()) { ctx.ui.notify("Tracking requires an interactive, saved Pi session.", "warning"); return; }
			if (commandBusy) { ctx.ui.notify("Finish the current tracking prompt first.", "warning"); return; }
			const action = args.trim();
			if (!["", "pause", "clear", "status"].includes(action)) { ctx.ui.notify("Usage: /track [pause|clear|status]", "warning"); return; }
			const currentGeneration = generation;
			commandBusy = true;
			try {
				if (!sessionId || sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Session changed; reload before tracking.");
				refresh();
				failed = false;
				if (action === "status") { checkpoint(ctx); ctx.ui.notify(statusText(), "info"); return; }
				if (state?.active && !owned && !await resolveInterrupted(ctx, currentGeneration)) return;
				if (generation !== currentGeneration) return;
				if (action === "clear") {
					if (!state || (!state.active && !state.intervals.length)) return;
					const semanticRevision = state.semanticRevision ?? state.revision;
					if (!await ctx.ui.confirm("Clear tracked time?", "Stop tracking and reset this session to zero? Previous intervals remain archived in the local ledger.")) return;
					if (generation !== currentGeneration) return;
					const at = now();
					state = database().update(sessionId, { semanticRevision }, current => {
						if (current?.active && !isTrackingOwner(current.active.owner, identity())) throw new Error("Tracker ownership changed.");
						return { version: 1, revision: 0, sessionId: sessionId!, cwd: ctx.cwd, intervals: [], active: null };
					}, at);
					owned = false;
					ctx.ui.notify("Tracking stopped and reset to zero. Previous record archived.", "info");
					return;
				}
				if (action === "pause") { checkpoint(ctx, true); ctx.ui.notify(statusText(), "info"); return; }
				if (!owned) {
					const at = now();
					let overlaps: string[] = [];
					state = database().update(sessionId, state?.revision, current => {
						overlaps = database().list().filter(other => other.sessionId !== sessionId && other.active).map(other => `${other.sessionId} (${other.cwd})`);
						const next = current ?? { version: 1, revision: 0, sessionId: sessionId!, cwd: ctx.cwd, intervals: [], active: null };
						next.active = { start: at, observedAt: at, owner: identity() };
						return next;
					});
					owned = true;
					if (overlaps.length) ctx.ui.notify(`Overlapping or unresolved trackers: ${overlaps.join(", ")}. Avoid billing the same time twice.`, "warning");
				} else checkpoint(ctx);
				ctx.ui.notify(statusText(), "info");
			} catch (error) { reportError(ctx, error instanceof Error ? error.message : String(error)); }
			finally { commandBusy = false; requestFocus(); }
		},
	});
	const snapshot = (at: number) => {
		// A second process may have paused or cleared this session since its last turn.
		try { refresh(); } catch { failed = true; }
		return stamp(at);
	};
	return Object.assign(snapshot, {
		focusSubscription: () => ({ focusSpans: owned && !failed, focusEpoch }),
		onFocusRequest: (listener: () => void) => { focusListener = listener; },
		focus: (span: FocusSpan) => {
		const ctx = currentContext;
		if (!ctx || ctx.mode !== "tui" || !sessionId) return;
		// Commit the receiver high-water mark only after the durable write succeeds.
		const candidate = coverage.clone();
		const confirmed = candidate.accept(span, now());
		if (!confirmed.length) { coverage = candidate; return; }
		try {
			refresh();
			if (!state || (state.active && !owned)) return;
			const intervals = [...state.intervals];
			if (state.active) intervals.push({ start: state.active.start, end: now() });
			const additions = confirmed.flatMap(part => intervals.map(interval => ({
				start: Math.max(part.start, interval.start), end: Math.min(part.end, interval.end), idle: part.idle,
			}))).filter(part => part.end > part.start);
			if (!additions.length) { coverage = candidate; return; }
			state = database().update(sessionId, state.revision, current => {
				if (!current) throw new Error("Tracker disappeared.");
				if (current.active) current.active.observedAt = Math.max(current.active.observedAt, span.end);
				for (const part of additions) {
					const spans = current.coverage ??= [];
					const last = spans.at(-1);
					if (last && last.end === part.start && last.idle === part.idle) last.end = part.end;
					else spans.push(part);
				}
				return current;
			}, undefined, true);
			coverage = candidate;
		} catch (error) { reportError(ctx, error instanceof Error ? error.message : String(error)); }
	} });
}
