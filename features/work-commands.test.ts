import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workFixture } from "../herdr/todos/work-test-fixture.js";
import { WorkIdeas } from "../herdr/todos/work-ideas.js";
import { registerTodosFeature } from "./todos.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";

test("/idea uses human source, reports age, and offline captures can be retried", async () => {
	const f = await workFixture();
	try {
		type Command = { handler(args: string, ctx: ExtensionContext): Promise<void> };
		const commands = new Map<string, Command>();
		const messages: string[] = [];
		registerTodosFeature(createTestExtensionApi({
			on() {}, registerTool() {},
			registerCommand(name: string, command: Command) { commands.set(name, command); },
		}), new WorkIdeas(f.client));
		const ctx = createTestExtensionContext({ cwd: f.cwd, ui: { notify(message: string) { messages.push(message); } } });
		await commands.get("idea")!.handler("Human idea", ctx);
		assert.equal([...f.items.values()][0]!.source, "idea");
		assert.match(messages.at(-1)!, /IDEA-000001 \(just now\)/);
		assert.deepEqual(await readdir(join(f.cwd, ".pi")), ["work.json"]);
		f.control.fail = 401;
		await commands.get("idea")!.handler("Offline", ctx);
		assert.match(messages.at(-1)!, /outbox \(blocked\)/);
		f.control.fail = 0;
		await commands.get("work-outbox")!.handler("retry", ctx);
		assert.equal(f.items.size, 2);
		assert.match(messages.at(-1)!, /0 pending, 0 blocked/);
	} finally { await f.close(); }
});
