import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const FAST_TIER = "priority";
const FAST_ENTRY_TYPE = "pi-adam-codex-fast";
const FAST_SHORTCUT = "alt+shift+tab" as const;

const FAST_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

type FastEntry = {
	enabled?: boolean;
};

export type CodexFastSnapshot = {
	enabled: boolean;
	eligible: boolean;
};

export function isCodexFastModel(model: Model<any> | undefined): model is Model<any> {
	return model?.provider === CODEX_PROVIDER && model.api === CODEX_API && FAST_MODEL_IDS.has(model.id);
}

export function isCodexFastEligible(ctx: ExtensionContext): boolean {
	return isCodexFastModel(ctx.model) && ctx.modelRegistry.isUsingOAuth(ctx.model);
}

export function applyCodexFastTier(payload: unknown, enabled: boolean, eligible: boolean): unknown {
	if (!enabled || !eligible || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const body = payload as Record<string, unknown>;
	if (body.service_tier === undefined) body.service_tier = FAST_TIER;
	return body;
}

export function registerCodexFastFeature(
	pi: ExtensionAPI,
	onChange: () => void,
): () => CodexFastSnapshot {
	let enabled = false;
	let currentCtx: ExtensionContext | undefined;

	const snapshot = (): CodexFastSnapshot => ({
		enabled,
		eligible: currentCtx ? isCodexFastEligible(currentCtx) : false,
	});

	const restore = (ctx: ExtensionContext) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== FAST_ENTRY_TYPE) continue;
			const value = (entry.data as FastEntry | undefined)?.enabled;
			if (typeof value === "boolean") enabled = value;
		}
	};

	const setEnabled = (next: boolean, ctx: ExtensionContext) => {
		enabled = next;
		pi.appendEntry(FAST_ENTRY_TYPE, { enabled });
		onChange();
	};

	const toggle = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		if (!isCodexFastEligible(ctx) && !enabled) {
			ctx.ui.notify("Fast mode requires a supported GPT-5.4–5.6 Codex model using ChatGPT OAuth", "warning");
			onChange();
			return;
		}
		setEnabled(!enabled, ctx);
		ctx.ui.notify(`Codex Fast mode ${enabled ? "on" : "off"}`, "info");
	};

	pi.registerCommand("fast", {
		description: "Toggle Codex Fast mode for this session",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut(FAST_SHORTCUT, {
		description: "Toggle Codex Fast mode",
		handler: (ctx) => toggle(ctx),
	});

	pi.on("before_provider_request", (event, ctx) => {
		currentCtx = ctx;
		if (!enabled || !isCodexFastEligible(ctx)) return;
		return applyCodexFastTier(event.payload, enabled, true);
	});

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		restore(ctx);
		onChange();
	});

	pi.on("model_select", (_event, ctx) => {
		currentCtx = ctx;
		onChange();
	});

	pi.on("session_shutdown", () => {
		currentCtx = undefined;
	});

	return snapshot;
}
