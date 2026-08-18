import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { JsonValueSchema } from "./codex-image-utils.ts";

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

const FastEntrySchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
});

const ProviderRequestBodySchema = Type.Record(Type.String(), JsonValueSchema);

type ProviderRequestBody = Static<typeof ProviderRequestBodySchema>;

export type CodexFastSnapshot = {
	enabled: boolean;
	eligible: boolean;
};

type CodexFastEligibilityContext = {
	model: Model<Api> | undefined;
	modelRegistry: Pick<ExtensionContext["modelRegistry"], "isUsingOAuth">;
};

export function isCodexModel(model: Model<Api> | undefined): model is Model<"openai-codex-responses"> {
	return model?.provider === CODEX_PROVIDER && model.api === CODEX_API;
}

export function isCodexFastModel(model: Model<Api> | undefined): model is Model<"openai-codex-responses"> {
	return isCodexModel(model) && FAST_MODEL_IDS.has(model.id);
}

export function isCodexFastEligible(ctx: CodexFastEligibilityContext): boolean {
	return isCodexFastModel(ctx.model) && ctx.modelRegistry.isUsingOAuth(ctx.model);
}

export function applyCodexFastTier(
	payload: ProviderRequestBody,
	enabled: boolean,
	eligible: boolean,
): ProviderRequestBody {
	if (enabled && eligible && payload.service_tier === undefined) payload.service_tier = FAST_TIER;
	return payload;
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
			if (Check(FastEntrySchema, entry.data) && entry.data.enabled !== undefined) enabled = entry.data.enabled;
		}
	};

	const setEnabled = (next: boolean) => {
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
		setEnabled(!enabled);
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
		if (!enabled || !isCodexFastEligible(ctx) || !Check(ProviderRequestBodySchema, event.payload)) return;
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
