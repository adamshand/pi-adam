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

export function collectImageBase64(payload: unknown, images: string[] = []): string[] {
	if (!payload || typeof payload !== "object") return images;
	if (Array.isArray(payload)) {
		for (const item of payload) collectImageBase64(item, images);
		return [...new Set(images)];
	}

	const record = payload as Record<string, unknown>;
	if (record.type === "image_generation_call" && typeof record.result === "string") {
		images.push(stripDataUrl(record.result));
	}
	for (const key of ["partial_image_b64", "b64_json", "image_base64", "base64", "data", "result"] as const) {
		const value = record[key];
		if (typeof value === "string" && isProbablyBase64Image(value)) images.push(stripDataUrl(value));
	}
	for (const value of Object.values(record)) collectImageBase64(value, images);
	return [...new Set(images)];
}

export function extractResponseId(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	if (Array.isArray(payload)) {
		for (const item of payload) {
			const id = extractResponseId(item);
			if (id) return id;
		}
		return undefined;
	}
	const record = payload as Record<string, unknown>;
	if (typeof record.id === "string" && record.id.startsWith("resp_")) return record.id;
	const response = record.response;
	if (response && typeof response === "object") {
		const id = (response as Record<string, unknown>).id;
		if (typeof id === "string") return id;
	}
	return undefined;
}

export function detectImageMimeType(base64: string): { mimeType: string; extension: string } {
	if (base64.startsWith("/9j/")) return { mimeType: "image/jpeg", extension: "jpg" };
	if (base64.startsWith("UklGR")) return { mimeType: "image/webp", extension: "webp" };
	return { mimeType: "image/png", extension: "png" };
}

export function parseSseDataBlocks(text: string): unknown[] {
	const events: unknown[] = [];
	for (const block of text.split(/\n\n+/)) {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			events.push(JSON.parse(data));
		} catch {
			// Ignore non-JSON SSE frames.
		}
	}
	return events;
}
