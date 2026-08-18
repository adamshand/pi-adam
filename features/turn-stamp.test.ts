import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	formatTurnStamp,
	registerTurnStampFeature,
	TURN_STAMP_ENTRY_TYPE,
	type TurnStampData,
} from "./turn-stamp.ts";
import { createTestExtensionApi } from "./test-extension.ts";

type HarnessContext = { mode: "tui" | "print" };
type Handler = (event: { message?: { role: "assistant" | "user" }; reason?: string }, ctx?: HarnessContext) => object | undefined;
type StampComponent = { render(width: number): string[]; invalidate(): void };
type RendererOptions = Record<never, never>;
type StampRenderer = (
	entry: { data?: TurnStampData },
	options: RendererOptions,
	theme: { fg(color: string, text: string): string },
) => StampComponent | undefined;

type AppendedEntry = {
	customType: string;
	data: TurnStampData;
};

function createHarness(now = new Date(2026, 7, 18, 13, 53).getTime()) {
	const handlers = new Map<string, Handler>();
	const appended: AppendedEntry[] = [];
	let renderer: StampRenderer | undefined;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerEntryRenderer(_customType: string, value: typeof renderer) {
			renderer = value;
		},
		appendEntry(customType: string, data: TurnStampData) {
			appended.push({ customType, data });
		},
	};

	registerTurnStampFeature(createTestExtensionApi(pi), () => now);
	return { appended, handlers, getRenderer: () => renderer };
}

test("formats an English full date in local time", () => {
	const localTimestamp = new Date(2026, 7, 18, 13, 53).getTime();
	assert.equal(formatTurnStamp(localTimestamp), "Tue 18 August 2026, 1:53PM");
	assert.equal(formatTurnStamp(Number.NaN), undefined);
});

test("appends one completion stamp after only the final settled turn", () => {
	const completedAt = new Date(2026, 7, 18, 13, 53).getTime();
	const { appended, handlers } = createHarness(completedAt);
	handlers.get("session_start")?.({ reason: "startup" }, { mode: "tui" });

	handlers.get("turn_end")?.({ message: { role: "assistant" } });
	handlers.get("turn_end")?.({ message: { role: "assistant" } });
	assert.deepEqual(appended, []);

	handlers.get("agent_settled")?.({});
	assert.deepEqual(appended, [
		{
			customType: TURN_STAMP_ENTRY_TYPE,
			data: { version: 1, completedAt },
		},
	]);

	handlers.get("agent_settled")?.({});
	assert.equal(appended.length, 1);
});

test("does not stamp user-only activity or non-TUI sessions", () => {
	const tui = createHarness();
	tui.handlers.get("session_start")?.({ reason: "startup" }, { mode: "tui" });
	tui.handlers.get("turn_end")?.({ message: { role: "user" } });
	tui.handlers.get("agent_settled")?.({});
	assert.deepEqual(tui.appended, []);

	const print = createHarness();
	print.handlers.get("session_start")?.({ reason: "startup" }, { mode: "print" });
	print.handlers.get("turn_end")?.({ message: { role: "assistant" } });
	print.handlers.get("agent_settled")?.({});
	assert.deepEqual(print.appended, []);
});

test("renders the stamp dimmed, right-aligned, and width-safe", () => {
	const completedAt = new Date(2026, 7, 18, 13, 53).getTime();
	const { getRenderer } = createHarness(completedAt);
	const renderer = getRenderer();
	assert.ok(renderer);
	let renderedColor: string | undefined;
	const component = renderer(
		{ data: { version: 1, completedAt } },
		{},
		{
			fg: (color: string, text: string) => {
				renderedColor = color;
				return text;
			},
		},
	);

	assert.ok(component);
	assert.deepEqual(component.render(40), ["              Tue 18 August 2026, 1:53PM"]);
	assert.equal(renderedColor, "dim");
	const narrow = component.render(12)[0];
	assert.ok(narrow);
	assert.equal(stripVTControlCharacters(narrow), "Tue 18 Augus");
});
