import assert from "node:assert/strict";
import test from "node:test";
import {
	collectImageBase64,
	detectImageMimeType,
	extractResponseId,
	parseSseDataBlocks,
	resolveResponsesUrl,
} from "./codex-image-utils.ts";

const IMAGE = "A".repeat(128);

test("extracts and deduplicates streamed image payloads", () => {
	const payload = {
		type: "image_generation_call",
		result: IMAGE,
		nested: { partial_image_b64: `data:image/png;base64,${IMAGE}` },
	};
	assert.deepEqual(collectImageBase64(payload), [IMAGE]);
});

test("parses JSON SSE frames and ignores done or malformed frames", () => {
	const text = [
		`event: response.output_item.added\ndata: ${JSON.stringify({ id: "resp_1" })}`,
		"data: not-json",
		"data: [DONE]",
	].join("\n\n");
	assert.deepEqual(parseSseDataBlocks(text), [{ id: "resp_1" }]);
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
