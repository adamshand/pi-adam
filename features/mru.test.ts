import assert from "node:assert/strict";
import test from "node:test";
import { getSubmittedSlashCommand, parseMruState, registerMruFeature } from "./mru.ts";
import { createTestExtensionApi } from "./test-extension.ts";

test("recognizes slash commands submitted with Enter", () => {
	assert.equal(getSubmittedSlashCommand("\r", "/reload"), "reload");
	assert.equal(getSubmittedSlashCommand("\n", "  /model gpt-5  "), "model");
	assert.equal(getSubmittedSlashCommand("x", "/reload"), undefined);
	assert.equal(getSubmittedSlashCommand("\r", "ordinary prompt"), undefined);
	assert.equal(getSubmittedSlashCommand("\r", "/"), undefined);
});

test("rejects malformed persisted command usage", () => {
	assert.deepEqual(parseMruState('{"version":1,"commands":{"reload":{"lastUsed":10,"count":2}}}'), {
		version: 1,
		commands: { reload: { lastUsed: 10, count: 2 } },
	});
	assert.equal(parseMruState('{"version":1,"commands":[]}'), undefined);
	assert.equal(parseMruState('{"version":1,"commands":{"reload":null}}'), undefined);
});

test("tracks command submissions without replacing the core editor", () => {
	type SessionContext = {
		mode: "tui";
		ui: {
			addAutocompleteProvider(): void;
			onTerminalInput(): () => void;
			getEditorText(): string;
			setEditorComponent(): void;
		};
	};
	type HarnessEvent = Record<never, never>;
	type HandlerResult = Record<string, string> | undefined;
	type Handler = (event: HarnessEvent, ctx: SessionContext) => HandlerResult;
	const handlers = new Map<string, Handler>();
	let terminalListenerInstalled = false;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	};

	registerMruFeature(createTestExtensionApi(pi));
	handlers.get("session_start")?.({}, {
		mode: "tui",
		ui: {
			addAutocompleteProvider() {},
			onTerminalInput() {
				terminalListenerInstalled = true;
				return () => {};
			},
			getEditorText() {
				return "";
			},
			setEditorComponent() {
				assert.fail("MRU tracking must not replace the editor or its kill ring");
			},
		},
	});

	assert.equal(terminalListenerInstalled, true);
});
