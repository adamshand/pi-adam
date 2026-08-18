import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";

export const JsonValueSchema = Type.Cyclic({
	JsonValue: Type.Union([
		Type.Null(),
		Type.Boolean(),
		Type.Number(),
		Type.String(),
		Type.Array(Type.Ref("JsonValue")),
		Type.Record(Type.String(), Type.Ref("JsonValue")),
	]),
}, "JsonValue");

export type JsonValue = Static<typeof JsonValueSchema>;
type JsonObject = { [key: string]: JsonValue };

export type ImageFormat = {
	mimeType: "image/jpeg" | "image/webp" | "image/png";
	extension: "jpg" | "webp" | "png";
};

const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);
const StringSchema = Type.String();

function isJsonObject(value: JsonValue): value is JsonObject {
	return Check(JsonObjectSchema, value);
}

function isString(value: JsonValue | undefined): value is string {
	return Check(StringSchema, value);
}

export function resolveResponsesUrl(model: { baseUrl: string }): string {
	const baseUrl = model.baseUrl.replace(/\/+$/, "");
	if (baseUrl.endsWith("/codex/responses")) return baseUrl;
	if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
	return `${baseUrl}/codex/responses`;
}

export function stripDataUrl(value: string): string {
	return value.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i)?.[1] ?? value;
}

function isProbablyBase64Image(value: string): boolean {
	const stripped = stripDataUrl(value);
	return stripped.length > 100 && /^[A-Za-z0-9+/=_-]+$/.test(stripped);
}

export function collectImageBase64(payload: JsonValue, images: string[] = []): string[] {
	if (Array.isArray(payload)) {
		for (const item of payload) collectImageBase64(item, images);
		return [...new Set(images)];
	}
	if (!isJsonObject(payload)) return images;

	if (payload.type === "image_generation_call" && isString(payload.result)) {
		images.push(stripDataUrl(payload.result));
	}
	for (const key of ["partial_image_b64", "b64_json", "image_base64", "base64", "data", "result"] as const) {
		const value = payload[key];
		if (isString(value) && isProbablyBase64Image(value)) images.push(stripDataUrl(value));
	}
	for (const value of Object.values(payload)) collectImageBase64(value, images);
	return [...new Set(images)];
}

export function extractResponseId(payload: JsonValue): string | undefined {
	if (Array.isArray(payload)) {
		for (const item of payload) {
			const id = extractResponseId(item);
			if (id) return id;
		}
		return undefined;
	}
	if (!isJsonObject(payload)) return undefined;
	if (isString(payload.id) && payload.id.startsWith("resp_")) return payload.id;
	const response = payload.response;
	if (response !== undefined && isJsonObject(response) && isString(response.id)) return response.id;
	return undefined;
}

export function detectImageMimeType(base64: string): ImageFormat {
	if (base64.startsWith("/9j/")) return { mimeType: "image/jpeg", extension: "jpg" };
	if (base64.startsWith("UklGR")) return { mimeType: "image/webp", extension: "webp" };
	return { mimeType: "image/png", extension: "png" };
}

export function parseSseDataBlocks(text: string): JsonValue[] {
	const events: JsonValue[] = [];
	for (const block of text.split(/\n\n+/)) {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			events.push(Parse(JsonValueSchema, JSON.parse(data)));
		} catch {
			// Ignore non-JSON or non-JSON-value SSE frames.
		}
	}
	return events;
}
