import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { registerSaveImageFeature, saveImageArtifact } from "./save-image.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
const image = { type: "image" as const, data: png, mimeType: "image/png" as const };

test("save_image saves bytes without shell limits and returns actual dimensions with unique filenames", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-save-image-"));
	try {
		const large = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(1024 * 1024)]).toString("base64");
		const params = { image: { ...image, data: large }, "target-path": "images" };
		const artifacts = await Promise.all([saveImageArtifact(params, cwd), saveImageArtifact(params, cwd)]);
		assert.notEqual(artifacts[0]!.outputPath, artifacts[1]!.outputPath);
		for (const artifact of artifacts) {
			assert.equal(artifact.width, 1);
			assert.equal(artifact.height, 1);
			assert.equal(artifact.mimeType, "image/png");
			assert.ok(artifact.outputPath.startsWith(join(cwd, "images")));
			const saved = await readFile(artifact.outputPath);
			assert.equal(saved.toString("base64"), large);
			assert.equal(artifact.bytes, saved.length);
		}
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("save_image rejects invalid data, mismatched MIME, oversized input, cancellation, and filesystem failures", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-save-image-"));
	try {
		for (const data of ["", "not base64!", "a===", "data:image/png;base64," + png, "AAAA", "A".repeat(28 * 1024 * 1024)]) {
			await assert.rejects(saveImageArtifact({ image: { ...image, data }, "target-path": cwd }, cwd));
		}
		await assert.rejects(saveImageArtifact({ image: { ...image, mimeType: "image/jpeg" }, "target-path": cwd }, cwd), /MIME/);
		await assert.rejects(saveImageArtifact({ image, "target-path": cwd }, cwd, AbortSignal.abort()));
		assert.deepEqual(await readdir(cwd), []);
		const blocked = join(cwd, "file");
		await writeFile(blocked, "keep");
		await assert.rejects(saveImageArtifact({ image, "target-path": blocked }, cwd));
		assert.equal(await readFile(blocked, "utf8"), "keep");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("save_image is Codemode-exposed and returns schema-valid metadata without base64", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-save-image-"));
	type Tool = {
		name: string; exposure: string; outputSchema: TSchema;
		execute(id: string, params: Parameters<typeof saveImageArtifact>[0], signal: undefined, update: undefined, ctx: ExtensionContext): Promise<{
			content: Array<{ type: string; text: string }>;
			structuredContent: Awaited<ReturnType<typeof saveImageArtifact>>;
		}>;
	};
	let tool: Tool | undefined;
	registerSaveImageFeature(createTestExtensionApi({ registerTool(value: Tool) { tool = value; } }));
	try {
		assert.ok(tool);
		assert.equal(tool.name, "save_image");
		assert.equal(tool.exposure, "codemode");
		const result = await tool.execute("test", { image, "target-path": cwd }, undefined, undefined, createTestExtensionContext({ cwd }));
		assert.ok(Check(tool.outputSchema, result.structuredContent));
		assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent);
		assert.ok(!JSON.stringify(result).includes(png));
	} finally { await rm(cwd, { recursive: true, force: true }); }
});
