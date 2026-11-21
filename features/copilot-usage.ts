import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import { sanitizeDiagnosticError } from "./diagnostics.ts";

/**
 * GitHub Copilot monthly premium-request usage, from the same undocumented
 * endpoint VS Code and Copilot CLI use (`/copilot_internal/user`). Authenticated
 * with Pi's stored GitHub OAuth token, not the short-lived Copilot API token.
 * GitHub asks clients not to poll this often; 5 minutes matches common tools.
 */

export const COPILOT_PROVIDER = "github-copilot";
export const COPILOT_USAGE_REFRESH_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = COPILOT_USAGE_REFRESH_MS * 2;
const USER_URL = "https://api.github.com/copilot_internal/user";

// Fields are optional and loosely typed: the shape has changed repeatedly
// (entitlement has been both a number and a string).
const Numberish = Type.Union([Type.Number(), Type.String()]);
const QuotaSchema = Type.Object({
	unlimited: Type.Optional(Type.Boolean()),
	entitlement: Type.Optional(Numberish),
	remaining: Type.Optional(Numberish),
	quota_remaining: Type.Optional(Numberish),
	percent_remaining: Type.Optional(Numberish),
	overage_count: Type.Optional(Numberish),
});
const UserSchema = Type.Object({
	copilot_plan: Type.Optional(Type.String()),
	quota_reset_date_utc: Type.Optional(Type.String()),
	quota_reset_date: Type.Optional(Type.String()),
	quota_snapshots: Type.Optional(Type.Object({ premium_interactions: Type.Optional(QuotaSchema) })),
});
export type CopilotUserResponse = Static<typeof UserSchema>;

export type CopilotUsageSnapshot = {
	/** Percent of the monthly premium-request allowance used. */
	monthUsed?: number;
	/** Epoch seconds. */
	monthResetAt?: number;
	premiumUsed?: number;
	premiumEntitlement?: number;
	premiumOverage?: number;
};

export type CopilotUsageState = {
	snapshot?: CopilotUsageSnapshot;
	status: "idle" | "loading" | "ready" | "stale" | "error";
	lastAttemptAt?: number;
	lastSuccessAt?: number;
	lastError?: string;
};

export type CopilotUsageFeature = {
	getState(): CopilotUsageState;
	refresh(ctx: ExtensionContext, options?: { force?: boolean; notify?: boolean }): Promise<void>;
};

export function isCopilotModel(model: Model<Api> | undefined): boolean {
	return model?.provider === COPILOT_PROVIDER;
}

// The schema admits number | string; Number() normalises both, empty strings excluded.
const number = (value: number | string | undefined) => {
	if (value === undefined || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};

export function snapshotFromCopilotUser(user: CopilotUserResponse): CopilotUsageSnapshot | undefined {
	const premium = user.quota_snapshots?.premium_interactions;
	const reset = Date.parse(user.quota_reset_date_utc ?? user.quota_reset_date ?? "");
	const monthResetAt = Number.isFinite(reset) ? reset / 1000 : undefined;
	const entitlement = number(premium?.entitlement);
	// Unlimited or zero-allowance plans have no meaningful percentage.
	if (!premium || premium.unlimited || !entitlement || entitlement <= 0) return monthResetAt === undefined ? undefined : { monthResetAt };
	const remaining = number(premium.quota_remaining) ?? number(premium.remaining);
	const percentRemaining = number(premium.percent_remaining);
	const monthUsed = percentRemaining !== undefined ? 100 - percentRemaining
		: remaining !== undefined ? (1 - remaining / entitlement) * 100 : undefined;
	const overage = number(premium.overage_count);
	return {
		monthUsed: monthUsed === undefined ? undefined : Math.min(100, Math.max(0, monthUsed)),
		monthResetAt,
		premiumUsed: remaining === undefined ? undefined : Math.max(0, Math.round(entitlement - remaining)),
		premiumEntitlement: entitlement,
		premiumOverage: overage && overage > 0 ? overage : undefined,
	};
}

const CredentialSchema = Type.Object({ type: Type.Literal("oauth"), refresh: Type.String({ minLength: 1 }) });

function githubToken(): string | undefined {
	try { return Parse(CredentialSchema, readStoredCredential(COPILOT_PROVIDER)).refresh; }
	catch { return undefined; }
}

async function loadSnapshot(signal: AbortSignal): Promise<CopilotUsageSnapshot> {
	// Pi's OAuth "refresh" is the long-lived GitHub token that this endpoint accepts.
	const token = githubToken();
	if (!token) throw new Error('No GitHub Copilot login found. Use /login github-copilot first.');
	const response = await fetch(USER_URL, {
		signal,
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/json",
			"User-Agent": "GitHubCopilotChat/0.35.0",
			"Editor-Version": "vscode/1.107.0",
			"Editor-Plugin-Version": "copilot-chat/0.35.0",
		},
	});
	if (!response.ok) throw new Error(`GitHub Copilot usage request failed (${response.status}).`);
	const snapshot = snapshotFromCopilotUser(Parse(UserSchema, await response.json()));
	if (!snapshot) throw new Error("GitHub Copilot did not report a premium-request quota.");
	return snapshot;
}

export function registerCopilotUsageFeature(pi: ExtensionAPI, onChange: () => void): CopilotUsageFeature {
	let state: CopilotUsageState = { status: "idle" };
	let timer: ReturnType<typeof setInterval> | undefined;
	let lifecycle: AbortController | undefined;
	let inFlight: Promise<void> | undefined;

	const getState = (): CopilotUsageState =>
		state.status === "ready" && state.lastSuccessAt && Date.now() - state.lastSuccessAt > STALE_AFTER_MS
			? { ...state, status: "stale" } : { ...state };

	const stop = () => {
		lifecycle?.abort(new Error("Copilot usage lifecycle ended."));
		lifecycle = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const refresh = (ctx: ExtensionContext, options: { force?: boolean; notify?: boolean } = {}): Promise<void> => {
		if (inFlight) return inFlight;
		const now = Date.now();
		if (!options.force && state.lastAttemptAt && now - state.lastAttemptAt < COPILOT_USAGE_REFRESH_MS) return Promise.resolve();
		const owner = lifecycle ?? new AbortController();
		state = { ...state, status: "loading", lastAttemptAt: now };
		onChange();
		inFlight = (async () => {
			try {
				const snapshot = await loadSnapshot(AbortSignal.any([owner.signal, AbortSignal.timeout(10_000)]));
				if (owner.signal.aborted) return;
				state = { snapshot, status: "ready", lastAttemptAt: now, lastSuccessAt: Date.now() };
				if (options.notify) ctx.ui.notify("Copilot usage refreshed", "info");
			} catch (error) {
				if (owner.signal.aborted) return;
				const lastError = sanitizeDiagnosticError(error instanceof Error ? error.message : String(error));
				state = { ...state, status: state.snapshot ? "stale" : "error", lastError };
				if (options.notify) ctx.ui.notify(lastError, "error");
			} finally {
				inFlight = undefined;
				onChange();
			}
		})();
		return inFlight;
	};

	const start = (ctx: ExtensionContext) => {
		stop();
		if (ctx.mode !== "tui" || !isCopilotModel(ctx.model)) return;
		lifecycle = new AbortController();
		void refresh(ctx, { force: !state.snapshot });
		timer = setInterval(() => void refresh(ctx), COPILOT_USAGE_REFRESH_MS);
		timer.unref?.();
	};

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("model_select", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => { stop(); state = { status: "idle" }; });

	pi.registerCommand("copilot-usage", {
		description: "Show GitHub Copilot monthly premium-request usage",
		handler: async (_args, ctx) => {
			await refresh(ctx, { force: true });
			const current = getState();
			const s = current.snapshot;
			if (!s) { ctx.ui.notify(current.lastError ?? "Copilot usage unavailable", "error"); return; }
			const parts = [
				s.monthUsed !== undefined ? `${Math.round(s.monthUsed)}% of monthly premium requests used` : "",
				s.premiumUsed !== undefined && s.premiumEntitlement ? `${s.premiumUsed.toLocaleString()} / ${s.premiumEntitlement.toLocaleString()}` : "",
				s.premiumOverage ? `${s.premiumOverage.toLocaleString()} over allowance` : "",
				s.monthResetAt ? `resets ${new Date(s.monthResetAt * 1000).toLocaleDateString()}` : "",
			].filter(Boolean);
			ctx.ui.notify(`Copilot: ${parts.join(" • ")}`, current.status === "stale" ? "warning" : "info");
		},
	});

	return { getState, refresh };
}
