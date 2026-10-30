import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	initTheme,
	type SessionEntry,
	ToolExecutionComponent,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";
import {
	formatDuration,
	previewArgs,
	registerToolCollapseFeature,
	ToolFoldTracker,
	turnsFromBranch,
	wrapToolRenderers,
} from "./tool-collapse.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";

initTheme("dark", false);

const ids = (count: number, prefix = "t") => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

test("keeps only the newest calls of a turn open", () => {
	const tracker = new ToolFoldTracker(5);
	for (const id of ids(7)) tracker.noteCall(id);
	assert.deepEqual(tracker.flush(), ["t0", "t1"]);
	assert.equal(tracker.isFolded("t1"), true);
	assert.equal(tracker.isFolded("t2"), false);
	tracker.noteCall("t6");
	assert.deepEqual(tracker.flush(), [], "noting a call twice changes nothing");
});

test("a new turn folds the whole previous turn and restarts the count", () => {
	const tracker = new ToolFoldTracker(5);
	for (const id of ids(3)) tracker.noteCall(id);
	tracker.flush();
	tracker.startTurn();
	assert.deepEqual(tracker.flush(), ["t0", "t1", "t2"]);
	for (const id of ids(5, "n")) tracker.noteCall(id);
	assert.deepEqual(tracker.flush(), []);
});

test("errors never fold and reopen if already folded", () => {
	const tracker = new ToolFoldTracker(1);
	tracker.noteCall("a");
	tracker.noteCall("b");
	tracker.flush();
	assert.equal(tracker.isFolded("a"), true);
	assert.equal(tracker.noteError("a"), true);
	assert.equal(tracker.isFolded("a"), false);
	tracker.startTurn();
	assert.deepEqual(tracker.flush(), ["b"]);
});

test("pending folds wait until flushed", () => {
	const tracker = new ToolFoldTracker(1);
	tracker.noteCall("a");
	tracker.noteCall("b");
	assert.equal(tracker.isFolded("a"), false, "scrolled-up users see no change until flush");
	tracker.flush();
	assert.equal(tracker.isFolded("a"), true);
});

test("restores folds from session history", () => {
	type FixtureMessage =
		| { role: "user"; content: string; timestamp: number }
		| { role: "assistant"; content: { type: "toolCall"; id: string; name: string; arguments: Record<string, never> }[] }
		| { role: "toolResult"; toolCallId: string; toolName: string; content: never[]; isError: boolean; timestamp: number };
	const entry = (message: FixtureMessage): SessionEntry =>
		// SAFETY: Test fixtures carry only the fields turnsFromBranch reads.
		({ type: "message", id: "e", parentId: null, timestamp: "", message }) as SessionEntry;
	const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: {} });
	const branch = [
		entry({ role: "user", content: "one", timestamp: 0 }),
		entry({ role: "assistant", content: [call("a"), call("b")] }),
		entry({ role: "toolResult", toolCallId: "b", toolName: "bash", content: [], isError: true, timestamp: 0 }),
		entry({ role: "user", content: "two", timestamp: 0 }),
		entry({ role: "assistant", content: [call("c"), call("d")] }),
	];
	const { turns, errorIds } = turnsFromBranch(branch);
	assert.deepEqual(turns, [["a", "b"], ["c", "d"]]);
	assert.deepEqual(errorIds, ["b"]);
	const tracker = new ToolFoldTracker(1);
	tracker.restore(turns, errorIds);
	assert.deepEqual(
		["a", "b", "c", "d"].map((id) => tracker.isFolded(id)),
		[true, false, true, false],
	);
});

test("previews the most meaningful argument on one line", () => {
	assert.equal(previewArgs({ timeout: 5, command: "rg foo\nmore" }), "rg foo …");
	assert.equal(previewArgs({ path: "/a/b.ts", offset: 3 }), "/a/b.ts");
	assert.equal(previewArgs({ other: "x" }), "x");
	assert.equal(previewArgs({}), "");
	assert.equal(formatDuration(1234), "1.2s");
	assert.equal(formatDuration(90_000), "1m 30s");
	assert.equal(formatDuration(undefined), "");
});

const fakeUi = { requestRender() {} };

/** Built-in tool definitions type their args; pi's resolver contract sees them as ToolRenderers. */
function renderersOf<Definition extends { renderShell?: ToolRenderers["renderShell"] }>(definition: Definition): ToolRenderers {
	// SAFETY: pi itself passes these same definitions to resolvers as ToolRenderers.
	return definition as ToolRenderers;
}

function renderRow(definition: ToolRenderers, folded: boolean, result = { isError: false }) {
	const hooks = { isFolded: () => folded, remember() {} };
	const wrapped = { ...definition, ...wrapToolRenderers("bash", definition, hooks) };
	// SAFETY: ToolExecutionComponent only calls requestRender on the TUI in these code paths.
	const component = new ToolExecutionComponent("bash", "id1", { command: "ls -la" }, {}, wrapped, fakeUi as TUI, "/tmp");
	component.setArgsComplete();
	component.markExecutionStarted();
	const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
	component.updateResult({ content: [{ type: "text", text }], details: undefined, isError: result.isError, durationMs: 1500 }, false);
	return component.render(80).map((line) => stripVTControlCharacters(line));
}

test("an open row looks like pi's default box", () => {
	const bash = renderersOf(createBashToolDefinition("/tmp"));
	// SAFETY: ToolExecutionComponent only calls requestRender on the TUI in these code paths.
	const plain = new ToolExecutionComponent("bash", "id1", { command: "ls -la" }, {}, bash, fakeUi as TUI, "/tmp");
	plain.setArgsComplete();
	plain.markExecutionStarted();
	const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
	plain.updateResult({ content: [{ type: "text", text }], details: undefined, isError: false, durationMs: 1500 }, false);
	const expected = plain.render(80).map((line) => stripVTControlCharacters(line));
	assert.deepEqual(renderRow(bash, false), expected);
});

test("a folded row is one summary line", () => {
	const lines = renderRow(renderersOf(createBashToolDefinition("/tmp")), true);
	assert.equal(lines.length, 2, "pi's spacer line plus the summary");
	assert.match(lines[1] ?? "", /✓ bash ls -la · 1\.5s/);
});

test("errors render open even when marked folded", () => {
	assert.ok(renderRow(renderersOf(createBashToolDefinition("/tmp")), true, { isError: true }).length > 3);
});

test("self-framed tools such as edit keep their own frame when open", () => {
	const edit = renderersOf(createEditToolDefinition("/tmp"));
	const hooks = { isFolded: () => false, remember() {} };
	const wrapped = wrapToolRenderers("edit", edit, hooks);
	assert.equal(wrapped.renderShell, "self");
});

test("registers a renderer for every tool and folds on new turns", () => {
	type HarnessEvent = { toolCallId?: string; parentToolCallId?: string };
	type HarnessContext = ReturnType<typeof createTestExtensionContext>;
	type Handler = (event: HarnessEvent, ctx?: HarnessContext) => void;
	const handlers = new Map<string, Handler>();
	let resolver: ((name: string, next: () => ToolRenderers | undefined) => ToolRenderers | undefined) | undefined;
	const pi = createTestExtensionApi({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerToolRenderer(value: typeof resolver) {
			resolver = value;
		},
	});
	const tracker = registerToolCollapseFeature(pi, 1);
	assert.ok(resolver?.("anything", () => undefined)?.renderCall, "falls back for tools without renderers");
	const ctx = createTestExtensionContext({
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		ui: { setWidget() {} },
	});
	handlers.get("session_start")?.({}, ctx);
	handlers.get("tool_execution_start")?.({ toolCallId: "a" });
	handlers.get("tool_execution_start")?.({ toolCallId: "nested", parentToolCallId: "a" });
	handlers.get("tool_execution_start")?.({ toolCallId: "b" });
	assert.equal(tracker.isFolded("a"), true);
	assert.equal(tracker.isFolded("nested"), false);
	handlers.get("agent_start")?.({});
	assert.equal(tracker.isFolded("b"), true);
});
