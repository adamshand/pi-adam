import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { WorkIdeas } from "../herdr/todos/work-ideas.js";
import { workFixture } from "../herdr/todos/work-test-fixture.js";
import { registerTodosFeature } from "./todos.ts";
import { registerCodexImageFeature } from "./codex-image.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";

type ToolArgs = { sync_work?: boolean; action?: string; id?: string; title?: string; progress?: string; prompt?: string; size?: string; "target-path"?: string; preview?: boolean };
type Result = {
	content: Array<{ type: string; text?: string; data?: string }>;
	structuredContent: {
		action?: string;
		offer?: string;
		items?: Array<{ id: string; kind: string; title: string; status?: string; work_id?: string }>;
		outputPath?: string;
		responseId?: string;
	};
};
type Tool = {
	name: string;
	outputSchema: TSchema;
	execute(id: string, args: ToolArgs, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<Result>;
};

function harness(cwd: string) {
	const tools = new Map<string, Tool>();
	const pi = createTestExtensionApi({
		on() {}, registerCommand() {},
		registerTool(tool: Tool) { tools.set(tool.name, tool); },
	});
	const ctx = createTestExtensionContext({ cwd, sessionManager: { getSessionId: () => "contract-test" } });
	const call = async (name: string, args: ToolArgs, context = ctx) => {
		const tool = tools.get(name)!;
		const result = await tool.execute("test-call", args, undefined, undefined, context);
		assert.ok(Check(tool.outputSchema, result.structuredContent), "result does not match output schema");
		return result;
	};
	return { pi, call };
}

test("work-item tools provide composable list and mutation results and reject failures", async () => {
	const fixture = await workFixture();
	const cwd = fixture.cwd;
	try {
		const { pi, call } = harness(cwd);
		registerTodosFeature(pi, new WorkIdeas(fixture.client));
		for (const name of ["todo", "idea"]) {
			assert.deepEqual((await call(name, { action: "list" })).structuredContent.items, []);
			await assert.rejects(call(name, { action: "create", title: " " }), /title is required/);
			await assert.rejects(call(name, { action: "update" }), /ID is required/);
			await assert.rejects(call(name, { action: "delete", id: "abcdef" }), /not found/);
		}
		const item = (result: Result) => {
			const items = result.structuredContent.items;
			assert.ok(Array.isArray(items));
			assert.equal(items.length, 1);
			return items[0]!;
		};
		const idea = item(await call("idea", { action: "create", title: "Try structured tools" }));
		assert.equal(idea.kind, "idea");
		assert.equal(item(await call("idea", { action: "update", id: idea.id, title: "Updated" })).title, "Updated");
		const todo = item(await call("idea", { action: "promote", id: idea.id }));
		assert.equal(todo.kind, "todo");
		assert.equal(item(await call("todo", { action: "get", id: todo.id })).id, todo.id);
		assert.equal(item(await call("todo", { action: "start", id: todo.id })).status, "in_progress");
		const completed = await call("todo", { action: "complete", id: todo.id });
		assert.equal(item(completed).status, "done");
		assert.match(completed.structuredContent.offer ?? "", /Ask the user/);
		assert.equal(fixture.items.get(todo.work_id!)?.state, "open");
		await call("todo", { action: "complete", id: todo.id, sync_work: false });
		assert.equal(fixture.items.get(todo.work_id!)?.state, "open");
		await call("todo", { action: "complete", id: todo.id, sync_work: true });
		assert.equal(fixture.items.get(todo.work_id!)?.state, "done");
		assert.deepEqual((await call("todo", { action: "list" })).structuredContent.items, []);
		assert.equal(item(await call("todo", { action: "list-all" })).id, todo.id);
		await assert.rejects(call("todo", { action: "defer", id: todo.id }), /unfinished Todos/);
		await call("todo", { action: "reopen", id: todo.id });
		const deferred = item(await call("todo", { action: "defer", id: todo.id }));
		assert.equal(deferred.kind, "idea");
		await call("idea", { action: "delete", id: deferred.id });
		const created = item(await call("todo", { action: "create", title: "Direct" }));
		await call("todo", { action: "update", id: created.id, progress: "testing" });
		await call("todo", { action: "delete", id: created.id });
	} finally { await fixture.close(); }
});

test("image generation returns artifact metadata by default and only attaches an image on explicit preview", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-image-contract-"));
	const originalFetch = globalThis.fetch;
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
	// The existing decoder requires a substantial payload; use a PNG signature and synthetic bytes.
	const base64 = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(100)]).toString("base64");
	try {
		const { pi, call } = harness(cwd);
		registerCodexImageFeature(pi);
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, "gpt-6-astra");
			assert.equal(body.tools[0].model, "gpt-image-2");
			return new Response(JSON.stringify({ id: "resp_test", output: [
				{ type: "image_generation_call", status: "completed", result: base64 },
			] }), { headers: { "content-type": "application/json" } });
		};
		const ctx = createTestExtensionContext({ cwd,
			model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra", baseUrl: "https://example.test" },
			modelRegistry: { async getApiKeyAndHeaders() { return { ok: true, headers: { Authorization: "test" } }; } },
		});
		for (const preview of [undefined, false, true]) {
			const result = await call("codex_image", { prompt: "test", size: "1024x1024", "target-path": cwd, preview }, ctx);
			assert.equal(result.content.some((part) => part.type === "image"), preview === true);
			assert.ok(result.structuredContent.outputPath);
			assert.equal(readFileSync(String(result.structuredContent.outputPath)).toString("base64"), base64);
			assert.equal(result.structuredContent.responseId, "resp_test");
			assert.ok(!JSON.stringify(result.structuredContent).includes(base64));
		}
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(cwd, { recursive: true, force: true });
	}
});
