import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AnnotatePopover, appendAnnotation, formatAnnotation, type Annotation } from "./annotate.ts";

function plainTheme(): Theme {
	const stub = { fg: (_color: string, text: string) => text };
	// SAFETY: The popover only calls theme.fg; the rest of Theme is never observed.
	return stub as Theme;
}
const theme = plainTheme();

function popover(selection = "some text") {
	const results: (Annotation | undefined)[] = [];
	const widget = new AnnotatePopover(selection, theme, result => results.push(result));
	widget.focused = true;
	return { widget, results };
}

test("reactions and comments quote the selection", () => {
	assert.equal(formatAnnotation("line one\n\nline two  ", { kind: "reaction", reaction: "down" }), "> line one\n>\n> line two\n👎");
	assert.equal(formatAnnotation(" use a queue ", { kind: "comment", text: " why not cron? " }), "> use a queue\nwhy not cron?");
});

test("annotations accumulate in the draft separated by a blank line", () => {
	const first = appendAnnotation("", "> a\n👍");
	assert.equal(first, "> a\n👍\n");
	assert.equal(appendAnnotation(first, "> b\n❓"), "> a\n👍\n\n> b\n❓\n");
	assert.equal(appendAnnotation("my intro\n\n\n", "> c\nok"), "my intro\n\n> c\nok\n");
});

test("1/2/3 on an empty input react immediately", () => {
	for (const [key, reaction] of [["1", "up"], ["2", "down"], ["3", "question"]] as const) {
		const { widget, results } = popover();
		widget.handleInput(key);
		assert.deepEqual(results, [{ kind: "reaction", reaction }]);
	}
});

test("typing a comment keeps digits as text and submits on Enter", () => {
	const { widget, results } = popover();
	for (const ch of "needs 2 retries") widget.handleInput(ch);
	assert.deepEqual(results, []);
	widget.handleInput("\r");
	assert.deepEqual(results, [{ kind: "comment", text: "needs 2 retries" }]);
});

test("Enter on an empty comment does nothing; Escape cancels", () => {
	const { widget, results } = popover();
	widget.handleInput("\r");
	assert.deepEqual(results, []);
	widget.handleInput("\x1b");
	assert.deepEqual(results, [undefined]);
});

test("popover previews long selections without overflowing", () => {
	const { widget } = popover(Array.from({ length: 7 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n"));
	const lines = widget.render(50);
	assert.ok(lines.some(line => stripTerminalSequences(line).includes("… 3 more lines")));
	for (const line of lines) assert.equal(visibleWidth(line), 50, line);
});
