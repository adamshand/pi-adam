import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const ENTRY_TYPE = "pi-adam-timers";
const MAX_TIMEOUT = 2_147_483_647;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const RepeatSchema = Type.Object({
	every: Type.Union([Type.Literal("daily"), Type.Literal("weekly")]),
	/** Local wall-clock time, HH:MM (24-hour). */
	time: Type.String(),
	/** Weekly only: 0 = Sunday … 6 = Saturday. */
	day: Type.Optional(Type.Number()),
});
export type Repeat = Static<typeof RepeatSchema>;
const TimerSchema = Type.Object({
	id: Type.String(),
	at: Type.Number(),
	message: Type.String(),
	repeat: Type.Optional(RepeatSchema),
});
const StateSchema = Type.Object({ timers: Type.Array(TimerSchema) });
type Timer = Static<typeof TimerSchema>;
type ListedTimer = { id: string; at: string; message: string; repeat?: string };

// Keep the tool's input schema a single flat object. GitHub Copilot's Gemini models reject any request whose
// tool parameters have a top-level anyOf (a Type.Union) with a bare "400 Bad Request", so per-action
// requirements are enforced in execute() instead.
const Parameters = Type.Object({
	action: Type.Union([Type.Literal("set"), Type.Literal("list"), Type.Literal("cancel")]),
	after: Type.Optional(Type.String({ description: "set: duration such as 30s, 33m, 2h, 1d (use exactly one of after, at or every)" })),
	at: Type.Optional(Type.String({ description: "set: full ISO timestamp with Z or UTC offset (use exactly one of after, at or every)" })),
	every: Type.Optional(Type.Union([Type.Literal("daily"), Type.Literal("weekly")], { description: "set: recurring timer; requires time, and day when weekly" })),
	time: Type.Optional(Type.String({ description: "set with every: local 24-hour time HH:MM, e.g. 09:00" })),
	day: Type.Optional(Type.String({ description: "set with every=weekly: weekday name, e.g. monday" })),
	message: Type.Optional(Type.String({ description: "set: instructions for the wake-up" })),
	id: Type.Optional(Type.String({ description: "cancel: timer id" })),
});

export function resolveTimerDeadline(after: string | undefined, at: string | undefined, now: number): number {
	let deadline: number;
	if (after !== undefined) {
		const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(after);
		if (!match) throw new Error("Use a duration such as 30s, 33m, 2h, or 1d.");
		const unit = match[2];
		const multiplier = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
		deadline = now + Number(match[1]) * multiplier;
	} else {
		if (!at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(at)) {
			throw new Error("Use a full ISO timestamp with Z or an explicit UTC offset.");
		}
		// Date.parse normalizes impossible dates; reject them before accepting a deadline.
		const date = at.slice(0, 10);
		const calendar = new Date(`${date}T00:00:00Z`);
		if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) {
			throw new Error("Invalid calendar date.");
		}
		if (Number(at.slice(11, 13)) > 23 || Number(at.slice(14, 16)) > 59 || Number(at.slice(17, 19)) > 59) {
			throw new Error("Invalid clock time.");
		}
		deadline = Date.parse(at);
	}
	if (!Number.isFinite(deadline) || deadline <= now || deadline > 8_640_000_000_000_000) {
		throw new Error("Timer deadline must be a valid future instant.");
	}
	return deadline;
}

/** Validate a recurring rule from tool arguments. */
export function resolveRepeat(every: "daily" | "weekly", time: string | undefined, day: string | undefined): Repeat {
	const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time?.trim() ?? "");
	if (!match) throw new Error("Use a local 24-hour time such as 09:00 or 17:30.");
	const normalized = `${match[1].padStart(2, "0")}:${match[2]}`;
	if (every === "daily") {
		if (day !== undefined) throw new Error("day only applies to weekly timers.");
		return { every, time: normalized };
	}
	const name = day?.trim().toLowerCase() ?? "";
	const index = WEEKDAYS.findIndex((weekday) => name.length >= 3 && weekday.startsWith(name));
	if (index < 0) throw new Error("Weekly timers need a day such as monday.");
	return { every, time: normalized, day: index };
}

/** Next local occurrence strictly after `after`. Uses local calendar arithmetic so DST shifts keep the wall-clock time. */
export function nextOccurrence(repeat: Repeat, after: number): number {
	const [hours, minutes] = repeat.time.split(":").map(Number);
	const candidate = new Date(after);
	candidate.setHours(hours, minutes, 0, 0);
	if (repeat.every === "weekly") candidate.setDate(candidate.getDate() + ((repeat.day ?? 0) - candidate.getDay() + 7) % 7);
	while (candidate.getTime() <= after) candidate.setDate(candidate.getDate() + (repeat.every === "weekly" ? 7 : 1));
	return candidate.getTime();
}

export function describeRepeat(repeat: Repeat): string {
	const [hours, minutes] = repeat.time.split(":").map(Number);
	const clock = `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
	if (repeat.every === "daily") return `daily at ${clock}`;
	const day = WEEKDAYS[repeat.day ?? 0];
	return `every ${day[0].toUpperCase()}${day.slice(1)} at ${clock}`;
}

export function formatTimerTime(at: number): string {
	return new Intl.DateTimeFormat("en-NZ", {
		weekday: "short", day: "numeric", month: "short", year: "numeric",
		hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
		timeZoneName: "short",
	}).format(at);
}

export function formatTimerRelative(at: number, now: number): string {
	const seconds = (at - now) / 1000;
	const magnitude = Math.abs(seconds);
	const [unit, divisor] = magnitude < 60 ? ["second", 1] as const
		: magnitude < 3600 ? ["minute", 60] as const
			: magnitude < 86_400 ? ["hour", 3600] as const : ["day", 86_400] as const;
	return new Intl.RelativeTimeFormat("en-NZ", { numeric: "always" }).format(Math.round(seconds / divisor), unit);
}

function formatPendingTimers(timers: Timer[], now: number): string {
	return timers.length === 0 ? "No pending timers." : timers.map((timer) =>
		`${timer.id} · ${formatTimerTime(timer.at)} · ${formatTimerRelative(timer.at, now)}${timer.repeat ? ` · repeats ${describeRepeat(timer.repeat)}` : ""} · ${timer.message}`).join("\n");
}

export function registerTimersFeature(pi: ExtensionAPI): void {
	let timers: Timer[] = [];
	let handle: ReturnType<typeof setTimeout> | undefined;
	let sessionId: string | undefined;
	let generation = 0;

	const clear = () => {
		generation++;
		if (handle !== undefined) clearTimeout(handle);
		handle = undefined;
	};
	const persist = () => pi.appendEntry(ENTRY_TYPE, { timers: timers.map((timer) => ({ ...timer })) });
	const listing = () => ({
		now: new Date().toISOString(),
		timers: timers.map((timer) => {
			const listed: ListedTimer = { id: timer.id, at: new Date(timer.at).toISOString(), message: timer.message };
			if (timer.repeat) listed.repeat = describeRepeat(timer.repeat);
			return listed;
		}),
	});
	const arm = () => {
		clear();
		if (!sessionId || timers.length === 0) return;
		const next = Math.min(...timers.map((timer) => timer.at));
		const armedGeneration = generation;
		handle = setTimeout(() => {
			if (generation !== armedGeneration || !sessionId) return;
			const now = Date.now();
			const due = timers.filter((timer) => timer.at <= now);
			// Recurring timers fire once however many occurrences were missed (e.g. asleep), then move to the next future one.
			timers = [
				...timers.filter((timer) => timer.at > now),
				...due.flatMap((timer) => timer.repeat ? [{ ...timer, at: nextOccurrence(timer.repeat, now) }] : []),
			];
			if (due.length > 0) {
				// Consume before dispatch so reload/resume cannot enqueue the same wake-up twice.
				persist();
				pi.sendMessage({
					customType: "pi-adam-timer-wakeup",
					display: true,
					content: `Timer woke at ${formatTimerTime(now)}:\n${due.map((timer) =>
						`- ${timer.id}, scheduled for ${formatTimerTime(timer.at)}${timer.repeat ? ` (repeats ${describeRepeat(timer.repeat)})` : ""}: ${timer.message}`).join("\n")}`,
					details: { timers: due, firedAt: now },
				}, { triggerTurn: true, deliverAs: "followUp" });
			}
			arm();
		}, Math.min(MAX_TIMEOUT, Math.max(0, next - Date.now())));
	};
	const restore = (ctx: ExtensionContext) => {
		clear();
		sessionId = ctx.sessionManager.getSessionId();
		timers = [];
		// Timers belong to the session, not a conversation branch: tree navigation must not resurrect them.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE && Check(StateSchema, entry.data)) {
				timers = entry.data.timers.map((timer) => ({ ...timer }));
			}
		}
		arm();
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		clear();
		sessionId = undefined;
		timers = [];
	});

	pi.registerTool({
		name: "timer",
		label: "Timer",
		description: "Schedule an agent wake-up without polling. One-shot: after (30s, 33m, 2h, 1d) or at (full ISO timestamp with timezone). Recurring: every daily|weekly with time (local HH:MM) and, for weekly, day (e.g. monday). Plus instructions to resume. Returns immediately; finish your turn to wait. Also list or cancel timers. Pi must remain running; overdue timers fire once on wake/resume and recurring ones then continue from the next future occurrence. Timers are session-owned across branches.",
		parameters: Parameters,
		outputSchema: Type.Object({
			now: Type.String(),
			timers: Type.Array(Type.Object({ id: Type.String(), at: Type.String(), message: Type.String(), repeat: Type.Optional(Type.String()) })),
			id: Type.Optional(Type.String()),
			at: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (sessionId !== ctx.sessionManager.getSessionId()) restore(ctx);
			if (params.action === "set") {
				const message = params.message?.trim() ? params.message : undefined;
				if (!message) throw new Error("Provide instructions for the wake-up.");
				if ([params.after, params.at, params.every].filter((value) => value !== undefined).length !== 1) {
					throw new Error("Provide exactly one of after, at or every.");
				}
				if (params.every === undefined && (params.time !== undefined || params.day !== undefined)) {
					throw new Error("time and day only apply to recurring (every) timers.");
				}
				const repeat = params.every ? resolveRepeat(params.every, params.time, params.day) : undefined;
				const at = repeat ? nextOccurrence(repeat, Date.now()) : resolveTimerDeadline(params.after, params.at, Date.now());
				const timer: Timer = repeat ? { id: randomUUID(), at, message, repeat } : { id: randomUUID(), at, message };
				timers.push(timer);
				persist();
				arm();
				const details = { ...listing(), id: timer.id, at: new Date(at).toISOString() };
				return {
					content: [{ type: "text", text: `${repeat ? `Recurring timer set (${describeRepeat(repeat)}); first` : "Timer set for"} ${formatTimerTime(at)} · ${formatTimerRelative(at, Date.parse(details.now))}\n${timer.id} · ${timer.message}` }],
					details, structuredContent: details,
				};
			}
			if (params.action === "cancel") {
				if (!params.id) throw new Error("Provide the id of the timer to cancel.");
				if (!timers.some((timer) => timer.id === params.id)) throw new Error(`No pending timer ${params.id}.`);
				timers = timers.filter((timer) => timer.id !== params.id);
				persist();
				arm();
			}
			const details = listing();
			const text = `${params.action === "cancel" ? `Timer cancelled: ${params.id}\n` : ""}${formatPendingTimers(timers, Date.parse(details.now))}`;
			return { content: [{ type: "text", text }], details, structuredContent: details };
		},
	});

	pi.registerCommand("timers", {
		description: "List pending wake-ups, or /timers cancel <id|all>",
		async handler(args, ctx) {
			if (sessionId !== ctx.sessionManager.getSessionId()) restore(ctx);
			const words = args.trim().split(/\s+/);
			if (words[0]) {
				if (words[0] !== "cancel" || words.length !== 2) {
					ctx.ui.notify("Usage: /timers or /timers cancel <id|all>", "warning");
					return;
				}
				const id = words[1];
				if (id !== "all" && !timers.some((timer) => timer.id === id)) {
					ctx.ui.notify(`No pending timer ${id}.`, "warning");
					return;
				}
				timers = id === "all" ? [] : timers.filter((timer) => timer.id !== id);
				persist();
				arm();
			}
			ctx.ui.notify(formatPendingTimers(timers, Date.now()), "info");
		},
	});
}
