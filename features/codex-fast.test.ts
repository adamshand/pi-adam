import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyCodexFastTier, isCodexFastEligible, isCodexFastModel, isCodexModel } from "./codex-fast.ts";

function model(id: string, provider = "openai-codex", api = "openai-codex-responses"): Model<any> {
	return { id, provider, api } as Model<any>;
}

test("identifies Codex models independently of Fast support", () => {
	assert.equal(isCodexModel(model("gpt-5.4-mini")), true);
	assert.equal(isCodexModel(model("gpt-5.6-sol", "openai")), false);
	assert.equal(isCodexModel(model("gpt-5.6-sol", "openai-codex", "openai-responses")), false);
});

test("allows Fast mode only on the supported Codex model and API combinations", () => {
	assert.equal(isCodexFastModel(model("gpt-5.6-sol")), true);
	assert.equal(isCodexFastModel(model("gpt-5.5")), true);
	assert.equal(isCodexFastModel(model("gpt-5.4-mini")), false);
	assert.equal(isCodexFastModel(model("gpt-5.6-sol", "openai")), false);
	assert.equal(isCodexFastModel(model("gpt-5.6-sol", "openai-codex", "openai-responses")), false);
});

test("requires ChatGPT OAuth in addition to a supported model", () => {
	const ctx = (oauth: boolean) => ({
		model: model("gpt-5.6-sol"),
		modelRegistry: { isUsingOAuth: () => oauth },
	}) as unknown as ExtensionContext;
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
