import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerHerdrTodosFeature } from "./herdr-todos.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

test("Alt-T reports an opening failure and can retry after the plugin is repaired", async () => {
	const previous = process.env.HERDR_ENV;
	process.env.HERDR_ENV = "1";
	const cwd = mkdtempSync(join(tmpdir(), "pi-board-toggle-"));
	type EmptyEvent = Record<never, never>;
	const handlers = new Map<string, (event: EmptyEvent, ctx: ExtensionContext) => Promise<void>>();
	let toggle: ((ctx: ExtensionContext) => Promise<void>) | undefined;
	let installed = false;
	const messages: string[] = [];
	const ctx = createTestExtensionContext({ cwd, sessionManager: { getSessionId: () => "toggle-test" }, ui: { notify(message: string) { messages.push(message); } } });
	try {
		registerHerdrTodosFeature(createTestExtensionApi({
			on(name: string, handler: (event: EmptyEvent, ctx: ExtensionContext) => Promise<void>) { handlers.set(name, handler); },
			registerCommand() {},
			registerShortcut(key: string, shortcut: { handler(ctx: ExtensionContext): Promise<void> }) { assert.equal(key, "alt+t"); toggle = shortcut.handler; },
			async exec(_cmd: string, args: string[]) {
				if (args.slice(0, 3).join(" ") === "plugin pane open") return installed
					? { code: 0, stdout: '{"result":{"plugin_pane":{"pane":{"pane_id":"test:board"}}}}', stderr: "" }
					: { code: 1, stdout: "", stderr: "manifest unavailable" };
				return { code: 0, stdout: '{"result":{"panes":[]}}', stderr: "" };
			},
		}));
		await handlers.get("session_start")?.({}, ctx);
		await toggle?.(ctx);
		assert.match(messages.at(-1)!, /could not open/);
		installed = true;
		await toggle?.(ctx);
		assert.match(messages.at(-1)!, /board shown/);
		await toggle?.(ctx);
		assert.match(messages.at(-1)!, /board hidden/);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous;
		rmSync(cwd, { recursive: true, force: true });
	}
});
