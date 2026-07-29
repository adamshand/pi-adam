// Image request/stream handling adapted from pi-codex-image-tool (MIT),
// https://github.com/ross-jill-ws/pi-codex-image-tool

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
	collectImageBase64,
	detectImageMimeType,
	extractResponseId,
	parseSseDataBlocks,
	resolveResponsesUrl,
	stripDataUrl,
} from "./codex-image-utils.ts";

const TOOL_NAME = "codex_image";
const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const IMAGE_GENERATION_TOOL_TYPE = "image_generation";
const IMAGE_MODEL = "gpt-image-2";
const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const DEFAULT_TARGET_PATH = "/tmp/pi-codex-image-tool";

const GenerateImageParams = Type.Object({
	prompt: Type.String({ description: "Detailed prompt describing the image to generate." }),
	size: StringEnum(IMAGE_SIZES, {
		description: "Output image size.",
		default: "1024x1024",
	}),
	"target-path": Type.String({
		description: "Directory where the generated image should be saved. Relative paths use the current working directory.",
		default: DEFAULT_TARGET_PATH,
	}),
});

type GenerateImageParamsType = Static<typeof GenerateImageParams>;

type GenerateImageDetails = {
	model: string;
	imageModel: typeof IMAGE_MODEL;
	size: GenerateImageParamsType["size"];
	targetPath: string;
	outputPath: string;
	mimeType: string;
	responseId?: string;
};

type SavedImage = {
	outputPath: string;
	mimeType: string;
	base64: string;
};

export function isCodexImageModel(model: Model<any> | undefined): model is Model<any> {
	return model?.provider === CODEX_PROVIDER
		&& model.api === CODEX_API
		&& /^gpt-5\.(?:5|6)(?:$|-)/.test(model.id);
}

function hasHeader(headers: Headers, name: string): boolean {
	for (const key of headers.keys()) {
		if (key.toLowerCase() === name.toLowerCase()) return true;
	}
	return false;
}

function extractChatGptAccountId(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
		const claims = JSON.parse(decoded) as Record<string, unknown>;
		const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
		return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

async function buildHeaders(ctx: ExtensionContext, model: Model<any>): Promise<Headers> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	const headers = new Headers(auth.headers);
	headers.set("content-type", "application/json");
	headers.set("accept", "text/event-stream, application/json");
	if (auth.apiKey && !hasHeader(headers, "authorization")) {
		headers.set("authorization", `Bearer ${auth.apiKey}`);
	}
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("originator", "pi");
	if (auth.apiKey && !hasHeader(headers, "chatgpt-account-id")) {
		const accountId = extractChatGptAccountId(auth.apiKey);
		if (accountId) headers.set("chatgpt-account-id", accountId);
	}
	return headers;
}

function buildRequestBody(model: Model<any>, params: GenerateImageParamsType) {
	return {
		model: model.id,
		store: false,
		stream: true,
		instructions: "You are a helpful assistant.",
		reasoning: { effort: "high", summary: "auto" },
		input: [{
			role: "user",
			content: [{ type: "input_text", text: params.prompt }],
		}],
		text: { verbosity: "medium" },
		tools: [{ type: IMAGE_GENERATION_TOOL_TYPE, model: IMAGE_MODEL, size: params.size }],
		tool_choice: { type: IMAGE_GENERATION_TOOL_TYPE },
		parallel_tool_calls: true,
	};
}

function resolveTargetPath(ctx: ExtensionContext, params: GenerateImageParamsType): string {
	const targetPath = params["target-path"] || DEFAULT_TARGET_PATH;
	return isAbsolute(targetPath) ? targetPath : resolve(ctx.cwd, targetPath);
}

async function saveImageToTarget(ctx: ExtensionContext, base64: string, params: GenerateImageParamsType): Promise<SavedImage> {
	const cleanBase64 = stripDataUrl(base64);
	const { mimeType, extension } = detectImageMimeType(cleanBase64);
	const targetPath = resolveTargetPath(ctx, params);
	const outputPath = join(targetPath, `image_${Date.now()}_${params.size.replace("x", "-")}.${extension}`);
	await mkdir(targetPath, { recursive: true });
	await writeFile(outputPath, Buffer.from(cleanBase64, "base64"));
	return { outputPath, mimeType, base64: cleanBase64 };
}

async function readImageResponseAndSave(
	response: Response,
	ctx: ExtensionContext,
	params: GenerateImageParamsType,
	onSaved?: (saved: SavedImage) => void,
): Promise<{ payload: unknown; saved: SavedImage }> {
	const saveFirst = async (payload: unknown, label: string) => {
		const imageBase64 = collectImageBase64(payload)[0];
		if (!imageBase64) throw new Error(`${label} did not contain base64 image data: ${JSON.stringify(payload).slice(0, 1000)}`);
		const saved = await saveImageToTarget(ctx, imageBase64, params);
		onSaved?.(saved);
		return saved;
	};

	if (!response.body) {
		const text = await response.text();
		const payload = /^\s*(?:event:|data:)/.test(text) ? parseSseDataBlocks(text) : JSON.parse(text);
		return { payload, saved: await saveFirst(payload, "Image generation response") };
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events: unknown[] = [];
	let buffer = "";
	let fullText = "";
	let saved: SavedImage | undefined;

	const processChunk = async (chunk: string) => {
		fullText += chunk;
		buffer += chunk;
		const blocks = buffer.split(/\n\n+/);
		buffer = blocks.pop() ?? "";
		for (const block of blocks) {
			for (const event of parseSseDataBlocks(block)) {
				events.push(event);
				if (saved) continue;
				const imageBase64 = collectImageBase64(event)[0];
				if (imageBase64) {
					saved = await saveImageToTarget(ctx, imageBase64, params);
					onSaved?.(saved);
				}
			}
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		await processChunk(decoder.decode(value, { stream: true }));
	}
	await processChunk(decoder.decode());
	if (buffer.trim()) await processChunk("\n\n");

	if (events.length === 0) {
		let payload: unknown;
		try {
			payload = JSON.parse(fullText);
		} catch {
			throw new Error(`Expected JSON or SSE response but received: ${fullText.slice(0, 500)}`);
		}
		return { payload, saved: await saveFirst(payload, "Image generation response") };
	}
	if (!saved) saved = await saveFirst(events, "Image generation stream");
	return { payload: events, saved };
}

export function registerCodexImageFeature(pi: ExtensionAPI): void {
	pi.registerTool<typeof GenerateImageParams, GenerateImageDetails>({
		name: TOOL_NAME,
		label: "Generate Image",
		description: `Generate an image through the current Codex model's native ${IMAGE_GENERATION_TOOL_TYPE} tool using ${IMAGE_MODEL}.`,
		promptSnippet: `Generate images with ${IMAGE_MODEL} through the current OpenAI Codex model.`,
		promptGuidelines: [
			"Use codex_image when the user asks to create, draw, generate, or render an image.",
			"Pass codex_image a detailed prompt, choose the requested size, and set target-path when the user specifies a save folder.",
		],
		parameters: GenerateImageParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = ctx.model;
			if (!isCodexImageModel(model)) {
				throw new Error(`${TOOL_NAME} requires a GPT-5.5 or GPT-5.6 model from ${CODEX_PROVIDER}.`);
			}
			const targetPath = resolveTargetPath(ctx, params);
			const details = (outputPath = "", mimeType = "image/png"): GenerateImageDetails => ({
				model: `${model.provider}/${model.id}`,
				imageModel: IMAGE_MODEL,
				size: params.size,
				targetPath,
				outputPath,
				mimeType,
			});
			onUpdate?.({
				content: [{ type: "text", text: `Requesting ${params.size} image from ${IMAGE_MODEL}...` }],
				details: details(),
			});

			const response = await fetch(resolveResponsesUrl(model), {
				method: "POST",
				headers: await buildHeaders(ctx, model),
				body: JSON.stringify(buildRequestBody(model, params)),
				signal,
			});
			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Image generation failed (${response.status}): ${errorText.slice(0, 1000)}`);
			}

			const { payload, saved } = await readImageResponseAndSave(response, ctx, params, (image) => {
				onUpdate?.({
					content: [{ type: "text", text: `Image data received and saved to ${image.outputPath}` }],
					details: details(image.outputPath, image.mimeType),
				});
			});
			return {
				content: [
					{ type: "text", text: `Generated image saved to ${saved.outputPath}` },
					{ type: "image", data: saved.base64, mimeType: saved.mimeType },
				],
				details: { ...details(saved.outputPath, saved.mimeType), responseId: extractResponseId(payload) },
			};
		},
	});

	const syncActiveTool = (model: Model<any> | undefined) => {
		const activeTools = pi.getActiveTools();
		const hasTool = activeTools.includes(TOOL_NAME);
		const shouldHaveTool = isCodexImageModel(model);
		if (shouldHaveTool && !hasTool) pi.setActiveTools([...activeTools, TOOL_NAME]);
		if (!shouldHaveTool && hasTool) pi.setActiveTools(activeTools.filter((name) => name !== TOOL_NAME));
	};

	pi.on("session_start", (_event, ctx) => syncActiveTool(ctx.model));
	pi.on("model_select", (event) => syncActiveTool(event.model));
}
