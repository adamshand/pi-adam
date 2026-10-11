import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);
const MimeSchema = Type.Union([
	Type.Literal("image/png"), Type.Literal("image/jpeg"),
	Type.Literal("image/webp"), Type.Literal("image/gif"),
]);
const Params = Type.Object({
	image: Type.Object({
		type: Type.Literal("image"),
		data: Type.String({ maxLength: MAX_BASE64, description: "Raw base64 from an image block; pass programmatically, never print it." }),
		mimeType: MimeSchema,
	}),
	"target-path": Type.Optional(Type.String({ description: "Destination directory, relative to the session cwd or absolute. Defaults to a temporary pi-image-artifacts directory." })),
});
const Output = Type.Object({
	outputPath: Type.String(), mimeType: MimeSchema,
	bytes: Type.Integer(), width: Type.Integer(), height: Type.Integer(),
});
type Artifact = Static<typeof Output>;
const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export async function saveImageArtifact(params: Static<typeof Params>, cwd: string, signal?: AbortSignal): Promise<Artifact> {
	signal?.throwIfAborted();
	const { data, mimeType } = params.image;
	if (!data || data.length > MAX_BASE64 || /[^A-Za-z0-9+/=]/.test(data)) {
		throw new Error("Expected raw base64 image data, at most 20 MiB decoded.");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > MAX_BYTES || bytes.toString("base64") !== data) {
		throw new Error("Invalid base64 or image exceeds the 20 MiB limit.");
	}
	const dimensions = getImageDimensions(data, mimeType);
	if (!dimensions || dimensions.widthPx <= 0 || dimensions.heightPx <= 0) {
		throw new Error("Image header does not match the supplied MIME type or has invalid dimensions.");
	}
	const directory = resolve(cwd, params["target-path"] || join(tmpdir(), "pi-image-artifacts"));
	await mkdir(directory, { recursive: true });
	signal?.throwIfAborted();
	const outputPath = join(directory, `image_${randomUUID()}.${extensions[mimeType]}`);
	const file = await open(outputPath, "wx", 0o600);
	try {
		await file.writeFile(bytes, { signal });
	} catch (error) {
		await file.close();
		await unlink(outputPath);
		throw error;
	}
	await file.close();
	return { outputPath, mimeType, bytes: bytes.length, width: dimensions.widthPx, height: dimensions.heightPx };
}

export function registerSaveImageFeature(pi: ExtensionAPI): void {
	pi.registerTool<typeof Params, Artifact>({
		name: "save_image",
		label: "Save Image",
		exposure: "codemode",
		description: "Save an image block from models.generateImages() to a unique local file; returns path, MIME type, byte count, and actual dimensions. No network calls or generation. Pass { image: block, 'target-path': directory }. Supports PNG/JPEG/WebP/GIF up to 20 MiB. Never print or store base64; inspect the saved path with read only when needed. Rejects invalid image headers; does not fully decode or transcode images.",
		parameters: Params,
		outputSchema: Output,
		async execute(_id, params, signal, _update, ctx) {
			const artifact = await saveImageArtifact(params, ctx.cwd, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(artifact) }],
				details: artifact,
				structuredContent: artifact,
			};
		},
	});
}
