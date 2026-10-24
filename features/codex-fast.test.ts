import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { applyCodexFastTier, isCodexFastEligible, isCodexModel } from "./codex-fast.ts";

function model(
	id: string,
	provider: Model<Api>["provider"] = "openai-codex",
	api: Api = "openai-codex-responses",
): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

test("identifies Codex models independently of Fast support", () => {
	assert.equal(isCodexModel(model("gpt-5.4-mini")), true);
	assert.equal(isCodexModel(model("gpt-5.6-sol", "openai")), false);
	assert.equal(isCodexModel(model("gpt-5.6-sol", "openai-codex", "openai-responses")), false);
});

test("allows any Codex model ID but rejects other providers and APIs", () => {
	const eligible = (selected: Model<Api> | undefined) => isCodexFastEligible({
		model: selected,
		modelRegistry: { isUsingOAuth: () => true },
	});
	for (const id of ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini", "gpt-6-astra", "future-model"]) {
		assert.equal(eligible(model(id)), true);
	}
	assert.equal(eligible(undefined), false);
	assert.equal(eligible(model("gpt-6-astra", "openai")), false);
	assert.equal(eligible(model("gpt-6-astra", "openai-codex", "openai-responses")), false);
});

test("requires ChatGPT OAuth in addition to a Codex model", () => {
	const ctx = (oauth: boolean) => ({
		model: model("gpt-6-astra"),
		modelRegistry: { isUsingOAuth: () => oauth },
	});
	assert.equal(isCodexFastEligible(ctx(true)), true);
	assert.equal(isCodexFastEligible(ctx(false)), false);
});

test("injects priority only when Fast mode is enabled and eligible", () => {
	assert.deepEqual(applyCodexFastTier({ model: "gpt-5.6-sol" }, true, true), {
		model: "gpt-5.6-sol",
		service_tier: "priority",
	});
	assert.deepEqual(applyCodexFastTier({ model: "gpt-5.6-sol" }, false, true), { model: "gpt-5.6-sol" });
	assert.deepEqual(applyCodexFastTier({ model: "gpt-5.6-sol" }, true, false), { model: "gpt-5.6-sol" });
});

test("does not overwrite a service tier supplied by Pi or another extension", () => {
	assert.deepEqual(applyCodexFastTier({ service_tier: "flex" }, true, true), { service_tier: "flex" });
});
