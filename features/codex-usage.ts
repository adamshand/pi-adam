import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Parse } from "typebox/value";

const RateLimitWindowSchema = Type.Object({
	used_percent: Type.Optional(Type.Number()),
	reset_at: Type.Optional(Type.Number()),
	limit_window_seconds: Type.Optional(Type.Number()),
});

const RateLimitSchema = Type.Object({
	primary_window: Type.Optional(Type.Union([RateLimitWindowSchema, Type.Null()])),
	secondary_window: Type.Optional(Type.Union([RateLimitWindowSchema, Type.Null()])),
});

const CodexUsageResponseSchema = Type.Object({
	rate_limit: Type.Optional(RateLimitSchema),
});

const ResetCreditsResponseSchema = Type.Object({
	available_count: Type.Optional(Type.Number()),
});

const JwtClaimsSchema = Type.Object({
	"https://api.openai.com/auth": Type.Optional(Type.Object({
		chatgpt_account_id: Type.Optional(Type.String()),
	})),
});

type RateLimitWindow = Static<typeof RateLimitWindowSchema>;
export type RateLimit = Static<typeof RateLimitSchema>;

export type CodexUsageSnapshot = {
	fiveHourUsed?: number;
	weeklyUsed?: number;
	fiveHourResetAt?: number;
	weeklyResetAt?: number;
	availableResets?: number;
};

const REFRESH_MS = 2 * 60 * 1000;
const API_BASE = "https://chatgpt.com/backend-api/wham";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function decodeBase64Url(input: string): string | undefined {
	try {
		const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
		return Buffer.from(padded, "base64").toString("utf8");
	} catch {
		return undefined;
	}
}

function getAccountIdFromJwt(accessToken: string): string | undefined {
	const payloadJson = decodeBase64Url(accessToken.split(".")[1] ?? "");
	if (!payloadJson) return undefined;
	try {
		return Parse(JwtClaimsSchema, JSON.parse(payloadJson))[JWT_CLAIM_PATH]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

async function getJson<Schema extends TSchema>(
	schema: Schema,
	path: string,
	accessToken: string,
	accountId?: string,
): Promise<Static<Schema>> {
	const headers = new Headers({
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		"User-Agent": "pi-adam",
	});
	if (accountId) headers.set("ChatGPT-Account-Id", accountId);

	const response = await fetch(`${API_BASE}/${path}`, {
		headers,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`Codex ${path} fetch failed (${response.status})`);
	return Parse(schema, await response.json());
}

export function snapshotFromRateLimit(rateLimit: RateLimit | undefined): CodexUsageSnapshot {
	const primary = rateLimit?.primary_window ?? undefined;
	const secondary = rateLimit?.secondary_window ?? undefined;
	const windows = [primary, secondary].filter((window): window is RateLimitWindow => window !== undefined);

	// OpenAI does not guarantee that primary means 5-hour and secondary means weekly.
	// Some plans now return only a weekly window in primary_window.
	const fiveHour = windows.find(
		(window) => window.limit_window_seconds !== undefined && window.limit_window_seconds <= 24 * 60 * 60,
	);
	const weekly = windows.find(
		(window) => window.limit_window_seconds !== undefined && window.limit_window_seconds > 24 * 60 * 60,
	);

	// Preserve the legacy positional mapping when the API omits window durations.
	const fallbackFiveHour = fiveHour ?? (primary?.limit_window_seconds === undefined ? primary : undefined);
	const fallbackWeekly = weekly ?? (secondary?.limit_window_seconds === undefined ? secondary : undefined);

	return {
		fiveHourUsed: fallbackFiveHour?.used_percent,
		weeklyUsed: fallbackWeekly?.used_percent,
		fiveHourResetAt: fallbackFiveHour?.reset_at,
		weeklyResetAt: fallbackWeekly?.reset_at,
	};
}

async function loadSnapshot(ctx: ExtensionContext): Promise<CodexUsageSnapshot> {
	const accessToken = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
	if (!accessToken) throw new Error('No Pi auth found for provider "openai-codex". Use /login first.');
	const accountId = getAccountIdFromJwt(accessToken);
	const [usageResult, creditsResult] = await Promise.allSettled([
		getJson(CodexUsageResponseSchema, "usage", accessToken, accountId),
		getJson(ResetCreditsResponseSchema, "rate-limit-reset-credits", accessToken, accountId),
	]);
	if (usageResult.status === "rejected") throw usageResult.reason;

	return {
		...snapshotFromRateLimit(usageResult.value.rate_limit),
		availableResets: creditsResult.status === "fulfilled" ? creditsResult.value.available_count : undefined,
	};
}

export function formatReset(epochSeconds: number | undefined): string | undefined {
	if (!epochSeconds) return undefined;
	const totalMinutes = Math.ceil((epochSeconds * 1000 - Date.now()) / 60_000);
	if (totalMinutes <= 0) return "now";
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	return `${minutes}m`;
}

export function registerCodexUsageFeature(pi: ExtensionAPI, onChange: () => void): () => CodexUsageSnapshot | undefined {
	let intervalId: ReturnType<typeof setInterval> | undefined;
	let snapshot: CodexUsageSnapshot | undefined;
	let lastError: string | undefined;

	const refresh = async (ctx: ExtensionContext, notify = false) => {
		try {
			snapshot = await loadSnapshot(ctx);
			lastError = undefined;
			onChange();
			if (notify) ctx.ui.notify("Codex usage refreshed", "info");
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			if (notify) ctx.ui.notify(lastError, "error");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await refresh(ctx);
		intervalId = setInterval(() => void refresh(ctx), REFRESH_MS);
	});

	pi.on("session_shutdown", () => {
		if (intervalId) clearInterval(intervalId);
		intervalId = undefined;
	});

	pi.registerCommand("codex-usage", {
		description: "Show current Codex 5-hour/weekly usage and banked reset availability",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			if (!snapshot) {
				ctx.ui.notify(lastError ?? "Codex usage unavailable", "error");
				return;
			}
			const parts: string[] = [];
			if (snapshot.fiveHourUsed !== undefined) parts.push(`5h ${Math.round(snapshot.fiveHourUsed)}% used`);
			if (snapshot.weeklyUsed !== undefined) parts.push(`weekly ${Math.round(snapshot.weeklyUsed)}% used`);
			const fiveHourReset = formatReset(snapshot.fiveHourResetAt);
			const weeklyReset = formatReset(snapshot.weeklyResetAt);
			if (fiveHourReset) parts.push(`5h resets in ${fiveHourReset}`);
			if (weeklyReset) parts.push(`weekly resets in ${weeklyReset}`);
			if (snapshot.availableResets !== undefined) parts.push(`${snapshot.availableResets} banked reset${snapshot.availableResets === 1 ? "" : "s"}`);
			ctx.ui.notify(`Codex: ${parts.join(" • ")}`, "info");
		},
	});

	pi.registerCommand("codex-usage-refresh", {
		description: "Refresh Codex usage now",
		handler: async (_args, ctx) => refresh(ctx, true),
	});

	return () => snapshot;
}
