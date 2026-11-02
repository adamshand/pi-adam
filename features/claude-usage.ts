import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import { formatReset } from "./codex-usage.ts";

/**
 * Claude subscription usage, read passively from the `claude-code.rate-limit`
 * diagnostic that pi-claude-code attaches to every assistant message. There is
 * no polling endpoint: the snapshot updates whenever a Claude turn completes.
 */

export const CLAUDE_CODE_PROVIDER = "claude-code";
const RATE_LIMIT_DIAGNOSTIC = "claude-code.rate-limit";

export type ClaudeUsageSnapshot = {
	fiveHourUsed?: number;
	weeklyUsed?: number;
	fiveHourResetAt?: number;
	weeklyResetAt?: number;
};

export type ClaudeUsageState = {
	snapshot?: ClaudeUsageSnapshot;
	status: "idle" | "ready";
	lastSuccessAt?: number;
};

export type ClaudeUsageFeature = {
	getState(): ClaudeUsageState;
};

const UsageWindowSchema = Type.Object({
	utilization: Type.Optional(Type.Number()),
	resetsAt: Type.Optional(Type.Number()),
});

const RateLimitInfoSchema = Type.Object({
	unifiedWindows: Type.Optional(Type.Object({
		five_hour: Type.Optional(UsageWindowSchema),
		seven_day: Type.Optional(UsageWindowSchema),
	})),
});

type RateLimitInfo = Static<typeof RateLimitInfoSchema>;
type UsageReading = { snapshot: ClaudeUsageSnapshot; at: number };

export function isClaudeCodeModel(model: Model<Api> | undefined): boolean {
	return model?.provider === CLAUDE_CODE_PROVIDER;
}

const percent = (utilization: number | undefined) => utilization === undefined ? undefined : utilization * 100;

/** Extract a usage snapshot from Claude Code's parsed `rate_limit_info`. */
export function snapshotFromRateLimitInfo(info: RateLimitInfo): ClaudeUsageSnapshot | undefined {
	const fiveHour = info.unifiedWindows?.five_hour;
	const weekly = info.unifiedWindows?.seven_day;
	if (fiveHour?.utilization === undefined && weekly?.utilization === undefined) return undefined;
	return {
		fiveHourUsed: percent(fiveHour?.utilization),
		weeklyUsed: percent(weekly?.utilization),
		fiveHourResetAt: fiveHour?.resetsAt,
		weeklyResetAt: weekly?.resetsAt,
	};
}

function parseRateLimitInfo(details: NonNullable<AssistantMessage["diagnostics"]>[number]["details"]): RateLimitInfo | undefined {
	try {
		return Parse(RateLimitInfoSchema, details);
	} catch {
		return undefined;
	}
}

function latestFromMessage(message: Pick<AssistantMessage, "diagnostics">): UsageReading | undefined {
	const diagnostics = message.diagnostics ?? [];
	for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
		const diagnostic = diagnostics[index];
		if (diagnostic?.type !== RATE_LIMIT_DIAGNOSTIC) continue;
		const info = parseRateLimitInfo(diagnostic.details);
		const snapshot = info && snapshotFromRateLimitInfo(info);
		if (snapshot) return { snapshot, at: diagnostic.timestamp };
	}
	return undefined;
}

/** A window whose reset time has passed is known to be empty again. */
function applyResets(snapshot: ClaudeUsageSnapshot, nowSeconds: number): ClaudeUsageSnapshot {
	const expired = (resetAt: number | undefined) => resetAt !== undefined && resetAt <= nowSeconds;
	return {
		...snapshot,
		fiveHourUsed: expired(snapshot.fiveHourResetAt) ? 0 : snapshot.fiveHourUsed,
		weeklyUsed: expired(snapshot.weeklyResetAt) ? 0 : snapshot.weeklyUsed,
	};
}

function detailedUsage(snapshot: ClaudeUsageSnapshot): string {
	const parts: string[] = [];
	if (snapshot.fiveHourUsed !== undefined) parts.push(`5h ${Math.round(snapshot.fiveHourUsed)}% used`);
	if (snapshot.weeklyUsed !== undefined) parts.push(`weekly ${Math.round(snapshot.weeklyUsed)}% used`);
	const fiveHourReset = formatReset(snapshot.fiveHourResetAt);
	const weeklyReset = formatReset(snapshot.weeklyResetAt);
	if (fiveHourReset) parts.push(`5h resets in ${fiveHourReset}`);
	if (weeklyReset) parts.push(`weekly resets in ${weeklyReset}`);
	return parts.join(" • ");
}

export function registerClaudeUsageFeature(pi: ExtensionAPI, onChange: () => void): ClaudeUsageFeature {
	let state: ClaudeUsageState = { status: "idle" };

	const record = (found: UsageReading | undefined) => {
		if (!found || (state.lastSuccessAt !== undefined && found.at < state.lastSuccessAt)) return;
		state = { snapshot: found.snapshot, status: "ready", lastSuccessAt: found.at };
		onChange();
	};

	const scanBranch = (ctx: ExtensionContext) => {
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
			const found = latestFromMessage(entry.message);
			if (found) return record(found);
		}
	};

	const getState = (): ClaudeUsageState => state.snapshot
		? { ...state, snapshot: applyResets(state.snapshot, Date.now() / 1000) }
		: { ...state };

	pi.on("session_start", (_event, ctx) => {
		state = { status: "idle" };
		if (isClaudeCodeModel(ctx.model)) scanBranch(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (!state.snapshot && isClaudeCodeModel(ctx.model)) scanBranch(ctx);
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") record(latestFromMessage(event.message));
	});

	pi.on("session_shutdown", () => {
		state = { status: "idle" };
	});

	pi.registerCommand("claude-usage", {
		description: "Show Claude subscription 5-hour/weekly usage from the latest Claude Code turn",
		handler: async (_args, ctx) => {
			if (!state.snapshot) scanBranch(ctx);
			const current = getState();
			if (!current.snapshot) {
				ctx.ui.notify("Claude usage appears after the first claude-code turn in this session.", "warning");
				return;
			}
			const asOf = current.lastSuccessAt ? ` • as of ${new Date(current.lastSuccessAt).toLocaleTimeString()}` : "";
			ctx.ui.notify(`Claude: ${detailedUsage(current.snapshot)}${asOf}`, "info");
		},
	});

	return { getState };
}
