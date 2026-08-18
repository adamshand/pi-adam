import assert from "node:assert/strict";
import test from "node:test";
import { getSubmittedSlashCommand, registerMruFeature } from "./mru.ts";

test("recognizes slash commands submitted with Enter", () => {
	assert.equal(getSubmittedSlashCommand("\r", "/reload"), "reload");
	assert.equal(getSubmittedSlashCommand("\n", "  /model gpt-5  "), "model");
	assert.equal(getSubmittedSlashCommand("x", "/reload"), undefined);
	assert.equal(getSubmittedSlashCommand("\r", "ordinary prompt"), undefined);
	assert.equal(getSubmittedSlashCommand("\r", "/"), undefined);
});

test("tracks command submissions without replacing the core editor", () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
	let terminalListenerInstalled = false;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	};

	registerMruFeature(pi as any);
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
