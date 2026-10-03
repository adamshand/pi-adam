import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const ENTRY_TYPE = "pi-adam-timers";
const MAX_TIMEOUT = 2_147_483_647;
const TimerSchema = Type.Object({
	id: Type.String(),
	at: Type.Number(),
	message: Type.String(),
});
const StateSchema = Type.Object({ timers: Type.Array(TimerSchema) });
type Timer = Static<typeof TimerSchema>;

const Parameters = Type.Union([
	Type.Object({ action: Type.Literal("set"), after: Type.String(), message: Type.String() }),
	Type.Object({ action: Type.Literal("set"), at: Type.String(), message: Type.String() }),
	Type.Object({ action: Type.Literal("list") }),
	Type.Object({ action: Type.Literal("cancel"), id: Type.String() }),
]);

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
		timers: timers.map((timer) => ({ ...timer, at: new Date(timer.at).toISOString() })),
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
			timers = timers.filter((timer) => timer.at > now);
			if (due.length > 0) {
				// Consume before dispatch so reload/resume cannot enqueue the same wake-up twice.
				persist();
				pi.sendMessage({
					customType: "pi-adam-timer-wakeup",
					display: true,
					content: `Timer wake-up at ${new Date(now).toISOString()}:\n${due.map((timer) =>
						`- ${timer.id}, scheduled ${new Date(timer.at).toISOString()}: ${timer.message}`).join("\n")}`,
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
		description: "Schedule a one-shot agent wake-up without polling. Use after (30s, 33m, 2h, 1d) or at (full ISO timestamp with timezone), plus instructions to resume. Returns immediately; finish your turn to wait. Also list or cancel timers. Pi must remain running; overdue timers fire on session resume. Timers are session-owned across branches.",
		parameters: Parameters,
		outputSchema: Type.Object({
			now: Type.String(),
			timers: Type.Array(Type.Object({ id: Type.String(), at: Type.String(), message: Type.String() })),
			id: Type.Optional(Type.String()),
			at: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (sessionId !== ctx.sessionManager.getSessionId()) restore(ctx);
			if (params.action === "set") {
				if (!params.message.trim()) throw new Error("Provide instructions for the wake-up.");
				const at = resolveTimerDeadline("after" in params ? params.after : undefined, "at" in params ? params.at : undefined, Date.now());
				const timer = { id: randomUUID(), at, message: params.message };
				timers.push(timer);
				persist();
				arm();
				const details = { ...listing(), id: timer.id, at: new Date(at).toISOString() };
				return { content: [{ type: "text", text: JSON.stringify(details) }], details, structuredContent: details };
			}
			if (params.action === "cancel") {
				if (!timers.some((timer) => timer.id === params.id)) throw new Error(`No pending timer ${params.id}.`);
				timers = timers.filter((timer) => timer.id !== params.id);
				persist();
				arm();
			}
			const details = listing();
			return { content: [{ type: "text", text: JSON.stringify(details) }], details, structuredContent: details };
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
			ctx.ui.notify(timers.length === 0 ? "No pending timers." : timers.map((timer) =>
				`${timer.id} · ${new Date(timer.at).toISOString()} · ${timer.message}`).join("\n"), "info");
		},
	});
}
