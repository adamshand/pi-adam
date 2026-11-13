// Local-only PTY regression fixture: the outer driver never sends a return key.
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";
import { registerStagedCommandsFeature, type CommandDraft } from "./staged-commands.ts";

let stage: ((id: string, args: CommandDraft, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<object>) | undefined;
let run: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
let restarted = false;
let delivered = false;
const ctx = createTestExtensionContext({
	mode: "tui", cwd: "/tmp", isIdle: () => true,
	ui: {
		setWidget() {},
		custom: (factory: (tui: { stop(): void; start(): void; requestRender(force: boolean): void }, theme: undefined, keys: undefined, done: (value: string) => void) => object) => new Promise<string>(resolve => {
			factory({ stop() {}, start() { restarted = true; }, requestRender() {} }, undefined, undefined, resolve);
		}),
	},
});
registerStagedCommandsFeature(createTestExtensionApi({
	on() {}, registerShortcut() {}, registerMessageRenderer() {},
	registerTool(tool: { execute: NonNullable<typeof stage> }) { stage = tool.execute; },
	registerCommand(name: string, command: { handler: NonNullable<typeof run> }) { if (name === "run") run = command.handler; },
	sendMessage(message: { content: string }, options: { triggerTurn: boolean }) {
		assert.ok(restarted);
		assert.equal(options.triggerTurn, true);
		assert.match(message.content, /Output:\n[\s\S]*return-fixture-output/);
		assert.match(message.content, /command failed · exit 7/);
		delivered = true;
	},
}));
assert.ok(stage);
assert.ok(run);
await stage("test", { title: "Automatic return test", script: "printf 'return-fixture-output\\n'; exit 7" }, undefined, undefined, ctx);
await run("", ctx);
assert.ok(delivered);
console.log("AUTO_RETURN_DELIVERED");
