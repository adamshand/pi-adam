import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerFooterFeature } from "./footer.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";

type TestEvent = {
	type: string;
	message?: { role: string; usage: { output?: number; cost: { total: number } } };
};
type EventHandler = (event: TestEvent, ctx: ExtensionContext) => void | Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => void | Promise<void>;
type RegisteredCommand = { handler: CommandHandler };
type FooterComponent = { render(width: number): string[]; dispose(): void; invalidate(): void };
type TestTui = { requestRender(): void };
type TestTheme = {
	name: string;
	fg(name: string, text: string): string;
	bold(text: string): string;
};
type TestFooterData = { onBranchChange(handler: () => void): () => void };
type FooterFactory = (tui: TestTui, theme: TestTheme, data: TestFooterData) => FooterComponent;

type AssistantEntry = {
	type: "message";
	message: {
		role: "assistant";
		usage: { cost: { total: number } };
	};
};

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		provider: "test-provider",
		api: "openai-responses",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

test("footer caches branch cost and context between lifecycle updates", async () => {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	let footerFactory: FooterFactory | undefined;
	let branchReads = 0;
	let contextReads = 0;
	let notification = "";
	let gitReads = 0;
	let branch: AssistantEntry[] = [{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } }];
	const ctx = createTestExtensionContext({
		mode: "tui" as const,
		model: model(),
		modelRegistry: {
			isUsingOAuth: () => false,
			getApiKeyForProvider: async () => undefined,
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => {
				branchReads += 1;
				return branch;
			},
		},
		getContextUsage: () => {
			contextReads += 1;
			return { tokens: 250, contextWindow: 1000, percent: 25 };
		},
		ui: {
			setFooter(factory: FooterFactory | undefined) { footerFactory = factory; },
			notify(text: string) { notification = text; },
		},
	});
	const pi = createTestExtensionApi({
		on(name: string, handler: EventHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
		registerShortcut() {},
		appendEntry() {},
		getThinkingLevel: () => "high",
		async exec(_command: string, args: string[]) {
			gitReads += 1;
			return { code: 0, stdout: args[0] === "diff" ? "142\t38\tfile\0" : "2\t3\n" };
		},
	});
	registerFooterFeature(pi);
	const emit = async (name: string, event: TestEvent = { type: name }) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};

	await emit("session_start");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(footerFactory, "session start did not install the footer");
	const component = footerFactory(
		{ requestRender() {} },
		{ name: "dark", fg: (_name, text) => text, bold: (text) => text },
		{ onBranchChange() { return () => undefined; } },
	);
	const first = component.render(100)[0] ?? "";
	const second = component.render(100)[0] ?? "";
	assert.equal(branchReads, 1);
	assert.equal(contextReads, 1);
	assert.equal(visibleWidth(first), 100);
	assert.equal(visibleWidth(second), 100);
	assert.match(first, /\+142.*−38.*↑2.*↓3/);
	assert.equal(gitReads, 2, "rendering must not run Git");
	for (let width = 1; width < 150; width += 1) {
		assert.ok(visibleWidth(component.render(width)[0] ?? "") <= width);
	}
	assert.doesNotMatch(component.render(35)[0] ?? "", /\+142/);

	const realDateNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		await emit("message_start", {
			type: "message_start",
			message: { role: "assistant", usage: { output: 0, cost: { total: 0 } } },
		});
		now = 3_000;
		await emit("message_end", {
			type: "message_end",
			message: { role: "assistant", usage: { output: 100, cost: { total: 0 } } },
		});
	} finally {
		Date.now = realDateNow;
	}
	assert.match(component.render(100)[0] ?? "", /50.*t\/s.*\$.*1\.00/);

	await emit("turn_end", {
		type: "turn_end",
		message: { role: "assistant", usage: { output: 0, cost: { total: 2 } } },
	});
	assert.equal(branchReads, 1, "turn completion rescanned the full branch");
	assert.match(component.render(100)[0] ?? "", /\$.*3\.00/);

	branch = [{ type: "message", message: { role: "assistant", usage: { cost: { total: 4 } } } }];
	await emit("session_tree");
	const updated = component.render(100)[0] ?? "";
	assert.equal(branchReads, 2);
	assert.equal(contextReads, 4);
	assert.match(updated, /\$.*4\.00/);

	await commands.get("pi-adam-status")?.handler("", ctx);
	assert.match(notification, /Fast:/);
	assert.match(notification, /Usage: ineligible/);
	assert.match(notification, /Context: 250\/1000 \(25\.0%\)/);

	await emit("session_shutdown");
});
