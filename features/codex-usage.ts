import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Parse } from "typebox/value";
import { sanitizeDiagnosticError } from "./diagnostics.ts";

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

export type CodexUsageStatusName = "idle" | "loading" | "ready" | "stale" | "error" | "ineligible";

export type CodexUsageState = {
	snapshot?: CodexUsageSnapshot;
	status: CodexUsageStatusName;
	eligible: boolean;
	modelKey: string;
	lastAttemptAt?: number;
	lastSuccessAt?: number;
	lastError?: string;
};

export type CodexUsageFeature = {
	getState(): CodexUsageState;
	refresh(ctx: ExtensionContext, options?: CodexUsageRefreshOptions): Promise<void>;
};

export type CodexUsageRefreshOptions = {
	force?: boolean;
	notify?: boolean;
};

type UsageRefreshRequest = {
	ctx: ExtensionContext;
	generation: number;
	force: boolean;
	notify: boolean;
};

type RefreshLoop = {
	generation: number;
	promise: Promise<void>;
};

export const CODEX_USAGE_REFRESH_MS = 2 * 60 * 1000;
const STALE_AFTER_MS = CODEX_USAGE_REFRESH_MS * 2;
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

function waitForSignal<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation was aborted."));
	return new Promise<Value>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(signal.reason ?? new Error("Operation was aborted."));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			() => {
				cleanup();
				reject(new Error("Codex credential lookup failed."));
			},
		);
	});
}

async function getJson<Schema extends TSchema>(
	schema: Schema,
	path: string,
	accessToken: string,
	signal: AbortSignal,
	accountId?: string,
): Promise<Static<Schema>> {
	const headers = new Headers({
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		"User-Agent": "pi-adam",
	});
	if (accountId) headers.set("ChatGPT-Account-Id", accountId);

	const response = await fetch(`${API_BASE}/${path}`, { headers, signal });
	if (!response.ok) throw new Error(`Codex ${path} fetch failed (${response.status})`);
	return Parse(schema, await response.json());
}

export function isCodexUsageEligible(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): boolean {
	const model = ctx.model;
	return model?.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(model);
}

function modelKey(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
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

async function loadSnapshot(ctx: ExtensionContext, signal: AbortSignal): Promise<CodexUsageSnapshot> {
	const accessToken = await waitForSignal(ctx.modelRegistry.getApiKeyForProvider("openai-codex"), signal);
	if (!accessToken) throw new Error('No Pi auth found for provider "openai-codex". Use /login first.');
	const accountId = getAccountIdFromJwt(accessToken);
	const [usageResult, creditsResult] = await Promise.allSettled([
		getJson(CodexUsageResponseSchema, "usage", accessToken, signal, accountId),
		getJson(ResetCreditsResponseSchema, "rate-limit-reset-credits", accessToken, signal, accountId),
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

function detailedUsage(snapshot: CodexUsageSnapshot): string[] {
	const parts: string[] = [];
	if (snapshot.fiveHourUsed !== undefined) parts.push(`5h ${Math.round(snapshot.fiveHourUsed)}% used`);
	if (snapshot.weeklyUsed !== undefined) parts.push(`weekly ${Math.round(snapshot.weeklyUsed)}% used`);
	const fiveHourReset = formatReset(snapshot.fiveHourResetAt);
	const weeklyReset = formatReset(snapshot.weeklyResetAt);
	if (fiveHourReset) parts.push(`5h resets in ${fiveHourReset}`);
	if (weeklyReset) parts.push(`weekly resets in ${weeklyReset}`);
	if (snapshot.availableResets !== undefined) parts.push(`${snapshot.availableResets} banked reset${snapshot.availableResets === 1 ? "" : "s"}`);
	return parts;
}

function mergeRefreshRequest(current: UsageRefreshRequest | undefined, next: UsageRefreshRequest): UsageRefreshRequest {
	if (!current || current.generation !== next.generation) return next;
	return {
		ctx: next.ctx,
		generation: next.generation,
		force: current.force || next.force,
		notify: current.notify || next.notify,
	};
}

export function registerCodexUsageFeature(pi: ExtensionAPI, onChange: () => void): CodexUsageFeature {
	let intervalId: ReturnType<typeof setInterval> | undefined;
	let lifecycleAbortController: AbortController | undefined;
	let generation = 0;
	let refreshLoop: RefreshLoop | undefined;
	let queuedRefresh: UsageRefreshRequest | undefined;
	let state: CodexUsageState = { status: "idle", eligible: false, modelKey: "none" };

	const currentState = (): CodexUsageState => {
		if (state.status === "ready" && state.lastSuccessAt && Date.now() - state.lastSuccessAt > STALE_AFTER_MS) {
			return { ...state, status: "stale" };
		}
		return { ...state };
	};

	const stop = () => {
		generation += 1;
		lifecycleAbortController?.abort(new Error("Codex usage lifecycle ended."));
		lifecycleAbortController = undefined;
		queuedRefresh = undefined;
		if (intervalId) clearInterval(intervalId);
		intervalId = undefined;
	};

	const performRefresh = async (request: UsageRefreshRequest) => {
		if (request.generation !== generation) return;
		const eligible = isCodexUsageEligible(request.ctx);
		const key = modelKey(request.ctx.model);
		if (!eligible) {
			state = { status: "ineligible", eligible: false, modelKey: key };
			onChange();
			if (request.notify) request.ctx.ui.notify("Codex usage requires an openai-codex model using ChatGPT OAuth.", "warning");
			return;
		}
		const now = Date.now();
		if (!request.force && state.lastAttemptAt && now - state.lastAttemptAt < CODEX_USAGE_REFRESH_MS) return;

		const lifecycleSignal = lifecycleAbortController?.signal;
		if (!lifecycleSignal) {
			const lastError = "Codex usage lifecycle is inactive.";
			state = {
				...state,
				status: state.snapshot ? "stale" : "error",
				eligible: true,
				modelKey: key,
				lastAttemptAt: now,
				lastError,
			};
			onChange();
			if (request.notify) request.ctx.ui.notify(lastError, "error");
			return;
		}
		state = { ...state, status: "loading", eligible: true, modelKey: key, lastAttemptAt: now };
		onChange();
		const signal = AbortSignal.any([lifecycleSignal, AbortSignal.timeout(10_000)]);
		try {
			const snapshot = await loadSnapshot(request.ctx, signal);
			if (request.generation !== generation || lifecycleSignal.aborted) return;
			state = {
				snapshot,
				status: "ready",
				eligible: true,
				modelKey: key,
				lastAttemptAt: now,
				lastSuccessAt: Date.now(),
			};
			onChange();
			if (request.notify) request.ctx.ui.notify("Codex usage refreshed", "info");
		} catch (error) {
			if (request.generation !== generation || lifecycleSignal.aborted) return;
			const lastError = sanitizeDiagnosticError(error instanceof Error ? error.message : String(error));
			state = {
				...state,
				status: state.snapshot ? "stale" : "error",
				eligible: true,
				modelKey: key,
				lastAttemptAt: now,
				lastError,
			};
			onChange();
			if (request.notify) request.ctx.ui.notify(lastError, "error");
		}
	};

	const drainRefreshes = async (first: UsageRefreshRequest) => {
		let request: UsageRefreshRequest | undefined = first;
		while (request) {
			await performRefresh(request);
			const next: UsageRefreshRequest | undefined = queuedRefresh?.generation === request.generation ? queuedRefresh : undefined;
			if (next) queuedRefresh = undefined;
			request = next;
		}
	};

	const refresh = (ctx: ExtensionContext, options: CodexUsageRefreshOptions = {}): Promise<void> => {
		const request: UsageRefreshRequest = {
			ctx,
			generation,
			force: options.force ?? false,
			notify: options.notify ?? false,
		};
		if (refreshLoop?.generation === generation) {
			queuedRefresh = mergeRefreshRequest(queuedRefresh, request);
			return refreshLoop.promise;
		}
		const promise = drainRefreshes(request).finally(() => {
			if (refreshLoop?.promise === promise) refreshLoop = undefined;
		});
		refreshLoop = { generation, promise };
		return promise;
	};

	const start = async (ctx: ExtensionContext) => {
		stop();
		lifecycleAbortController = new AbortController();
		const activeGeneration = generation;
		const eligible = isCodexUsageEligible(ctx);
		state = eligible
			? { ...state, status: "idle", eligible: true, modelKey: modelKey(ctx.model), lastError: undefined }
			: { status: "ineligible", eligible: false, modelKey: modelKey(ctx.model) };
		onChange();
		if (eligible) await refresh(ctx, { force: true });
		if (activeGeneration !== generation || !eligible) return;
		intervalId = setInterval(() => void refresh(ctx), CODEX_USAGE_REFRESH_MS);
		intervalId.unref?.();
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await start(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		void start(ctx);
	});

	pi.on("session_shutdown", () => {
		stop();
		state = { status: "idle", eligible: false, modelKey: state.modelKey };
	});

	pi.registerCommand("codex-usage", {
		description: "Show current Codex 5-hour/weekly usage and banked reset availability",
		handler: async (_args, ctx) => {
			await refresh(ctx, { force: true });
			const current = currentState();
			if (!current.eligible) {
				ctx.ui.notify("Codex usage requires an openai-codex model using ChatGPT OAuth.", "warning");
				return;
			}
			if (!current.snapshot) {
				ctx.ui.notify(current.lastError ?? "Codex usage unavailable", "error");
				return;
			}
			const freshness = current.status === "stale" ? ` • stale${current.lastError ? `: ${current.lastError}` : ""}` : "";
			ctx.ui.notify(`Codex: ${detailedUsage(current.snapshot).join(" • ")}${freshness}`, current.status === "stale" ? "warning" : "info");
		},
	});

	pi.registerCommand("codex-usage-refresh", {
		description: "Refresh Codex usage now",
		handler: async (_args, ctx) => refresh(ctx, { force: true, notify: true }),
	});

	return { getState: currentState, refresh };
}
