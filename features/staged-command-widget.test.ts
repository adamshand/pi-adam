import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { commandResultCard, StagedCommandWidget, type CommandAction } from "./staged-command-widget.ts";

export function testTheme(): Theme {
	// SAFETY: The widget uses only fg; no other theme method is exercised here.
	// @ts-expect-error Deliberately minimal theme test double.
	return { fg: (_color: string, text: string) => text };
}

export function click(x: number, y: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent {
	return { type, button: "left", x, y, screenX: x, screenY: y, width: 80, height: 10, shift: false, ctrl: false, alt: false };
}

test("completed command card wraps output inside an inert matching border", () => {
	const card = commandResultCard("[command completed · exit 0]\n$ id\n\nuid=0(root) 日本語", testTheme());
	for (const width of [80, 20, 6, 4, 1]) {
		const lines = card.render(width);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		if (width >= 6) {
			assert.ok(lines[0].startsWith("┌"));
			assert.ok(lines.at(-1)!.startsWith("└"));
		}
	}
	assert.ok(card.render(80).some(line => line.includes("uid=0(root)")));
	assert.match(card.render(80)[1], /^│ +│$/);
	assert.match(card.render(80).at(-2)!, /^│ +│$/);
	assert.equal(card.handleMouse, undefined);
	card.invalidate();
});

test("card exposes mouse actions without taking keyboard focus or intercepting scrolling", () => {
	const actions: CommandAction[] = [];
	const widget = new StagedCommandWidget({ title: "Disk usage", location: "local · sudo root · /tmp", command: "sudo -k -- /bin/sh -c 'du -sh /opt'" }, testTheme(), action => actions.push(action));
	const lines = widget.render(80);
	const y = lines.findIndex(line => line.includes("[ ▶ Run ]"));
	for (const label of ["[ ▶ Run ]", "[ Copy ]", "[ Dismiss ]"]) {
		const x = lines[y].indexOf(label);
		assert.equal(widget.handleMouse(click(x, y, "press"))?.handled, true);
		assert.equal(widget.handleMouse(click(x, y))?.handled, true);
	}
	assert.deepEqual(actions, ["run", "copy", "dismiss"]);
	assert.equal(widget.handleMouse(click(0, 0)), undefined);
	assert.equal(widget.handleMouse(click(0, y, "wheel")), undefined);
	assert.equal(widget.handleMouse({ ...click(0, y), shift: true }), undefined);
	widget.invalidate();
	assert.equal(widget.handleMouse(click(0, y)), undefined);
});

test("bordered card spaces the command and can hide keyboard hints", () => {
	const widget = new StagedCommandWidget({ title: "Check disk", location: "/tmp", command: "du -sh /opt" }, testTheme(), () => {}, () => 6, () => false);
	const lines = widget.render(60);
	assert.ok(lines[0].startsWith("┌"));
	assert.ok(lines.at(-1)!.startsWith("└"));
	assert.match(lines[1], /^│  # Check disk/);
	assert.match(lines[2], /^│  \/tmp/);
	assert.match(lines[3], /^│ +│$/);
	assert.match(lines[4], /^│  \$ du -sh \/opt/);
	assert.match(lines[5], /^│ +│$/);
	assert.ok(!lines.join("\n").includes("/dismiss"));
	assert.equal(widget.handleMouse(click(0, 6)), undefined, "border isn't a button");
	assert.equal(widget.handleMouse(click(2, 6)), undefined, "padding isn't a button");
});

test("card is bounded on narrow screens, wraps buttons and rebuilds hit regions on resize", () => {
	const actions: CommandAction[] = [];
	const widget = new StagedCommandWidget({ title: "日本語 title", location: "a very long directory", command: "a\n".repeat(1000) }, testTheme(), action => actions.push(action), () => 2);
	for (const width of [80, 20, 10, 4, 1]) {
		const lines = widget.render(width);
		assert.ok(lines.length <= 14);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
	}
	const lines = widget.render(20);
	for (const label of ["[ ▶ Run ]", "[ Copy ]", "[ Dismiss ]"]) {
		const y = lines.findIndex(line => line.includes(label));
		assert.ok(y >= 0);
		widget.handleMouse(click(lines[y].indexOf(label), y));
	}
	assert.deepEqual(actions, ["run", "copy", "dismiss"]);
});
