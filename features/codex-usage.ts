import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type RateLimitWindow = {
	used_percent?: number;
	reset_at?: number;
	limit_window_seconds?: number;
};

export type RateLimit = {
	primary_window?: RateLimitWindow | null;
	secondary_window?: RateLimitWindow | null;
};

type CodexUsageResponse = {
	rate_limit?: RateLimit;
};

type ResetCreditsResponse = {
	available_count?: number;
};

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
		const payload = JSON.parse(payloadJson) as Record<string, unknown>;
		const auth = payload[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
		return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

async function getJson<T>(path: string, accessToken: string, accountId?: string): Promise<T> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		"User-Agent": "pi-adam",
	};
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;

	const response = await fetch(`${API_BASE}/${path}`, {
		headers,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`Codex ${path} fetch failed (${response.status})`);
	return (await response.json()) as T;
}

export function snapshotFromRateLimit(rateLimit: RateLimit | undefined): CodexUsageSnapshot {
	const primary = rateLimit?.primary_window ?? undefined;
	const secondary = rateLimit?.secondary_window ?? undefined;
	const windows = [primary, secondary].filter((window): window is RateLimitWindow => window !== undefined);

	// OpenAI does not guarantee that primary means 5-hour and secondary means weekly.
	// Some plans now return only a weekly window in primary_window.
	const fiveHour = windows.find(
		(window) => typeof window.limit_window_seconds === "number" && window.limit_window_seconds <= 24 * 60 * 60,
	);
	const weekly = windows.find(
		(window) => typeof window.limit_window_seconds === "number" && window.limit_window_seconds > 24 * 60 * 60,
	);

	// Preserve the legacy positional mapping when the API omits window durations.
	const fallbackFiveHour = fiveHour ?? (primary?.limit_window_seconds === undefined ? primary : undefined);
	const fallbackWeekly = weekly ?? (secondary?.limit_window_seconds === undefined ? secondary : undefined);

	return {
		fiveHourUsed: typeof fallbackFiveHour?.used_percent === "number" ? fallbackFiveHour.used_percent : undefined,
		weeklyUsed: typeof fallbackWeekly?.used_percent === "number" ? fallbackWeekly.used_percent : undefined,
		fiveHourResetAt: typeof fallbackFiveHour?.reset_at === "number" ? fallbackFiveHour.reset_at : undefined,
		weeklyResetAt: typeof fallbackWeekly?.reset_at === "number" ? fallbackWeekly.reset_at : undefined,
	};
}

async function loadSnapshot(ctx: ExtensionContext): Promise<CodexUsageSnapshot> {
	const accessToken = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
	if (!accessToken) throw new Error('No Pi auth found for provider "openai-codex". Use /login first.');
	const accountId = getAccountIdFromJwt(accessToken);
	const [usageResult, creditsResult] = await Promise.allSettled([
		getJson<CodexUsageResponse>("usage", accessToken, accountId),
		getJson<ResetCreditsResponse>("rate-limit-reset-credits", accessToken, accountId),
	]);
	if (usageResult.status === "rejected") throw usageResult.reason;

	return {
		...snapshotFromRateLimit(usageResult.value.rate_limit),
		availableResets:
			creditsResult.status === "fulfilled" && typeof creditsResult.value.available_count === "number"
				? creditsResult.value.available_count
				: undefined,
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
