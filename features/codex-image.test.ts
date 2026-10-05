import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildHeaders, formatImageGenerationError, readImageResponseAndSave } from "./codex-image.ts";
import { createTestExtensionContext } from "./test-extension.ts";
import {
	collectCompletedImageBase64,
	detectImageMimeType,
	type JsonValue,
	extractResponseId,
	parseSseDataBlocks,
	resolveResponsesUrl,
} from "./codex-image-utils.ts";

const headerTestModel: Model<Api> = {
	id: "test-model", name: "test-model", provider: "openai-codex",
	api: "openai-codex-responses", baseUrl: "https://example.test",
	reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000, maxTokens: 100,
};

test("image headers omit null values and preserve provider authorization", async () => {
	const ctx = createTestExtensionContext({
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "fallback", headers: {
					Authorization: "Bearer provider",
					"X-Remove": "old",
					"x-remove": null,
					"X-Keep": "kept",
				} };
			},
		},
	});
	const headers = await buildHeaders(ctx, headerTestModel);
	assert.equal(headers.get("authorization"), "Bearer provider");
	assert.equal(headers.has("x-remove"), false);
	assert.equal(headers.get("x-keep"), "kept");
});

test("image headers support absent provider headers and API key fallback", async () => {
	const ctx = createTestExtensionContext({
		modelRegistry: {
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "fallback" }; },
		},
	});
	const headers = await buildHeaders(ctx, headerTestModel);
	assert.equal(headers.get("authorization"), "Bearer fallback");
});

const PARTIAL_IMAGE = Buffer.from("partial preview".repeat(12)).toString("base64");
const FINAL_IMAGE = Buffer.from("final image".repeat(16)).toString("base64");

test("extracts only completed image generation results", () => {
	const payload: JsonValue = [
		{ partial_image_b64: PARTIAL_IMAGE },
		{
			type: "response.output_item.done",
			item: { type: "image_generation_call", status: "completed", result: FINAL_IMAGE },
		},
	];
	assert.deepEqual(collectCompletedImageBase64(payload), [FINAL_IMAGE]);
});

test("does not treat a status-less image generation call as completed", () => {
	assert.deepEqual(collectCompletedImageBase64({ type: "image_generation_call", result: FINAL_IMAGE }), []);
});

test("waits for a completed streamed image instead of saving its partial preview", async () => {
	const targetPath = mkdtempSync(join(tmpdir(), "pi-adam-codex-image-"));
	const sse = [
		`data: ${JSON.stringify({ partial_image_b64: PARTIAL_IMAGE })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", result: FINAL_IMAGE } })}`,
	].join("\r\n\r\n");
	try {
		const response = new Response(sse, { headers: { "content-type": "text/event-stream" } });
		const result = await readImageResponseAndSave(response, { cwd: targetPath }, {
			prompt: "draw",
			size: "1024x1024",
			"target-path": targetPath,
		});

		assert.equal(result.saved.base64, FINAL_IMAGE);
		assert.equal(readFileSync(result.saved.outputPath).toString("base64"), FINAL_IMAGE);
	} finally {
		rmSync(targetPath, { recursive: true, force: true });
	}
});

test("rejects a stream containing only partial image previews", async () => {
	const targetPath = mkdtempSync(join(tmpdir(), "pi-adam-codex-image-partial-"));
	try {
		const response = new Response(`data: ${JSON.stringify({ partial_image_b64: PARTIAL_IMAGE })}\n\n`);
		await assert.rejects(
			readImageResponseAndSave(response, { cwd: targetPath }, {
				prompt: "draw",
				size: "1024x1024",
				"target-path": targetPath,
			}),
			/completed image generation result/,
		);
	} finally {
		rmSync(targetPath, { recursive: true, force: true });
	}
});

test("parses JSON SSE frames with LF or CRLF and ignores done or malformed frames", () => {
	const text = [
		`event: response.output_item.added\r\ndata: ${JSON.stringify({ id: "resp_1" })}`,
		"data: not-json",
		"data: [DONE]",
	].join("\r\n\r\n");
	assert.deepEqual(parseSseDataBlocks(text), [{ id: "resp_1" }]);
});

test("redacts provider secrets from image generation errors", () => {
	const message = formatImageGenerationError(503, "Authorization: Bearer secret-token accountId=acct_1234567890abcdef");
	assert.match(message, /503/);
	assert.ok(!message.includes("secret-token"));
	assert.ok(!message.includes("acct_1234567890abcdef"));
});

test("finds response ids in direct and wrapped events", () => {
	assert.equal(extractResponseId([{ response: { id: "resp_nested" } }]), "resp_nested");
	assert.equal(extractResponseId({ id: "item_1" }), undefined);
});

test("resolves Codex response URLs without duplicating path segments", () => {
	assert.equal(resolveResponsesUrl({ baseUrl: "https://chatgpt.com/backend-api" }), "https://chatgpt.com/backend-api/codex/responses");
	assert.equal(resolveResponsesUrl({ baseUrl: "https://example.test/codex/" }), "https://example.test/codex/responses");
	assert.equal(resolveResponsesUrl({ baseUrl: "https://example.test/codex/responses" }), "https://example.test/codex/responses");
});

test("detects common generated image formats", () => {
	assert.deepEqual(detectImageMimeType("/9j/abc"), { mimeType: "image/jpeg", extension: "jpg" });
	assert.deepEqual(detectImageMimeType("UklGRabc"), { mimeType: "image/webp", extension: "webp" });
	assert.deepEqual(detectImageMimeType("iVBORabc"), { mimeType: "image/png", extension: "png" });
});
