import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";
import { commandInvocation, commandPreview, copiedCommand, prepareCommand, quoteShell, registerStagedCommandsFeature, type CommandDraft } from "./staged-commands.ts";

function harness() {
	const events = new Map<string, () => void>();
	const widgets: (((tui: TUI, theme: Theme) => Component) | undefined)[] = [];
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	let stage: ((id: string, args: CommandDraft, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ content: { text: string }[]; structuredContent: { id: string; status: "pending" } }>) | undefined;
	const stagedTexts: string[] = [];
	let lastScript = "";
	const continuations: boolean[] = [];
	let idle = true;
	let mode = "tui";
	let executions = 0;
	const messages: { content: string; display: boolean }[] = [];
	const notices: string[] = [];
	const ctx = createTestExtensionContext({
		cwd: "/tmp", get mode() { return mode; }, isIdle: () => idle,
		ui: {
			setWidget: (_key: string, factory: ((tui: TUI, theme: Theme) => Component) | undefined) => widgets.push(factory),
			custom: async () => { executions++; return `[command completed · exit 0]\n$ /bin/sh -c '${lastScript}'\n\nexample output`; },
			notify: (text: string) => notices.push(text),
		},
	});
	registerStagedCommandsFeature(createTestExtensionApi({
		on: (name: string, handler: (event: undefined, ctx: ExtensionContext) => void) => events.set(name, () => handler(undefined, ctx)),
		registerTool: (tool: { execute: NonNullable<typeof stage> }) => { stage = tool.execute; },
		registerCommand: (name: string, entry: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, entry.handler),
		registerMessageRenderer: () => {},
		sendMessage: (message: { content: string; display: boolean }, options: { triggerTurn: boolean }) => { messages.push(message); continuations.push(options.triggerTurn); },
	}));
	assert.ok(stage);
	return {
		card: () => {
			const factory = widgets.at(-1);
			assert.ok(factory);
			// SAFETY: the factory uses only terminal.rows and theme.fg.
			// @ts-expect-error Minimal TUI/theme doubles for the widget factory.
			return factory({ terminal: { rows: 40 }, mode: "fullscreen" }, { fg: (_color: string, text: string) => text });
		},
		stage: async (script = "false") => {
			const result = await stage!("id", { title: "Test", script }, undefined, undefined, ctx);
			lastScript = script;
			stagedTexts.push(result.content[0].text);
			return result;
		},
		run: (args = "") => commands.get("run")!(args, ctx),
		dismiss: () => commands.get("dismiss")!("", ctx),
		events, messages, notices, commands, widgets, stagedTexts, continuations,
		busy: () => { idle = false; }, rpc: () => { mode = "rpc"; },
		executions: () => executions,
	};
}

test("staging publishes exact invocation without execution; replacement runs only latest", async () => {
	const h = harness();
	await h.stage("echo first");
	await h.stage("echo second");
	assert.equal(h.executions(), 0);
	assert.equal(h.widgets.length, 2);
	assert.equal(h.widgets.at(-1), undefined);
	h.events.get("agent_settled")!();
	assert.ok(h.widgets.at(-1));
	assert.match(h.stagedTexts[0], /\$ \/bin\/sh -c 'echo first'/);
	assert.match(h.stagedTexts[1], /Replaced staged command/);
	assert.equal(h.messages.length, 0, "no duplicate staging message");
	await h.run();
	assert.equal(h.executions(), 1);
	assert.equal(h.widgets.at(-1), undefined);
	assert.deepEqual(h.continuations, [true]);
	assert.match(h.messages.at(-1)!.content, /echo second/);
	assert.ok(!h.messages.at(-1)!.content.includes("echo first"));
	await h.run();
	assert.equal(h.executions(), 1);
	assert.equal(h.notices.at(-1), "No staged command.");
	assert.ok(!h.commands.has("commands"));
});

test("approval card appears only after settlement and hides while another turn runs", async () => {
	const h = harness();
	await h.stage();
	assert.equal(h.widgets.at(-1), undefined);
	h.events.get("agent_settled")!();
	assert.ok(h.widgets.at(-1));
	h.events.get("agent_start")!();
	assert.equal(h.widgets.at(-1), undefined);
	h.events.get("agent_settled")!();
	assert.ok(h.widgets.at(-1));
	await h.dismiss();
	h.events.get("agent_settled")!();
	assert.equal(h.widgets.at(-1), undefined);
});

test("dismiss and session boundaries clear the pending command", async () => {
	for (const event of ["dismiss", "session_start", "session_shutdown"]) {
		const h = harness(); await h.stage();
		if (event === "dismiss") await h.dismiss();
		else h.events.get(event)!();
		await h.run();
		assert.equal(h.executions(), 0);
		assert.equal(h.notices.at(-1), "No staged command.");
	}
});

test("busy, non-TUI and argument-bearing /run cannot execute", async () => {
	for (const state of ["busy", "rpc", "arguments"] as const) {
		const h = harness(); await h.stage();
		if (state !== "arguments") h[state]();
		await h.run(state === "arguments" ? "CMD-1" : "");
		assert.equal(h.executions(), 0);
	}
});

test("invalid replacement preserves the previously staged command", async () => {
	const h = harness();
	await h.stage("echo original");
	await assert.rejects(h.stage("\x1b[2J"));
	await h.run();
	assert.match(h.messages.at(-1)!.content, /echo original/);
});

test("clicks on replaced cards cannot run the replacement; current Run is one-shot", async () => {
	const h = harness();
	await h.stage("echo old");
	h.events.get("agent_settled")!();
	const old = h.card();
	await h.stage("echo new");
	h.events.get("agent_settled")!();
	const current = h.card();
	function runClick(card: Component) {
		const lines = card.render(80);
		const y = lines.findIndex(line => line.includes("[ ▶ Run ]"));
		const x = lines[y].indexOf("[ ▶ Run ]");
		card.handleMouse?.({ type: "click", button: "left", x, y, screenX: 0, screenY: y, width: 80, height: 10, shift: false, ctrl: false, alt: false });
	}
	runClick(old);
	await settle();
	assert.equal(h.executions(), 0);
	assert.match(h.notices.at(-1)!, /no longer pending/);
	runClick(current);
	runClick(current);
	await settle();
	assert.equal(h.executions(), 1);
	assert.equal(h.widgets.at(-1), undefined);
});

test("copy preserves local directory and script, while SSH already carries remote directory", () => {
	const local = prepareCommand({ title: "Test", script: "printf '%s' \"a'b\"", cwd: "/tmp" }, "id", "/ignored");
	assert.match(copiedCommand(local), /^cd \/tmp && /);
	const result = spawnSync("/bin/sh", ["-c", copiedCommand(local)], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "a'b");
	const remote = prepareCommand({ title: "Test", script: "pwd", target: "host", cwd: "/srv" }, "id", "/ignored");
	assert.match(copiedCommand(remote), /^ssh /);
	assert.ok(copiedCommand(remote).includes("/srv"));
});

test("local scripts preserve quotes, unicode, tabs and multiline whitespace", () => {
	const script = "printf '%s\\n' \"it's fine\"\n\tprintf '%s' '日本語'";
	const command = prepareCommand({ title: "Test", script }, "CMD-1", "/tmp");
	assert.ok(Object.isFrozen(command));
	const invocation = commandInvocation(command);
	const result = spawnSync(invocation.file, invocation.args, { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "it's fine\n日本語");
	const copied = [invocation.file, ...invocation.args].map(quoteShell).join(" ");
	assert.equal(spawnSync("/bin/sh", ["-c", copied], { encoding: "utf8" }).stdout, result.stdout);
});

test("SSH preview omits transport flags without changing execution or Copy", () => {
	const command = prepareCommand({ title: "Remote identity", script: "id", target: "172.16.1.52", root: true }, "id", "/tmp");
	const preview = commandPreview(command);
	assert.equal(preview, "ssh 172.16.1.52 'sudo -k -- /bin/sh -c id'");
	assert.ok(!preview.includes("StrictHostKeyChecking"));
	assert.ok(!preview.includes("ssh -t"));
	assert.ok(preview.includes("sudo -k --"));
	assert.ok(copiedCommand(command).startsWith("ssh -t -o StrictHostKeyChecking=yes -- 172.16.1.52 "));
	assert.deepEqual(commandInvocation(command).args.slice(0, 4), ["-t", "-o", "StrictHostKeyChecking=yes", "--"]);
});

test("SSH invocation carries one quoted remote command with exact Python source", () => {
	const script = "for i in range(2):\n    print(\"it's working\")\n";
	const command = prepareCommand({ title: "Python", target: "adam@prod", root: true, interpreter: "python3", script, cwd: "/srv/a'b" }, "CMD-2", "/ignored");
	const invocation = commandInvocation(command);
	assert.equal(invocation.file, "ssh");
	assert.equal(invocation.args.length, 6);
	assert.deepEqual(invocation.args.slice(0, 5), ["-t", "-o", "StrictHostKeyChecking=yes", "--", "adam@prod"]);
	assert.ok(invocation.args[5].includes("sudo"));
	assert.ok(invocation.args[5].includes("python3"));
	assert.ok(!invocation.args[5].includes("/ignored"));
});

test("remote shell parsing preserves nested command and root arguments without contacting SSH", () => {
	const script = "printf '%s' \"a'b\"\nprintf '%s' '\"$HOME`false`'";
	const invocation = commandInvocation(prepareCommand({ title: "Quote test", target: "prod", script }, "CMD-1", "/tmp"));
	const result = spawnSync("/bin/sh", ["-c", invocation.args.at(-1)!], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "a'b\"$HOME`false`");
});

test("SSH cwd wrapper still preserves quoting and changes directory before execution", () => {
	const command = prepareCommand({ title: "cwd", target: "prod", cwd: "/tmp", script: "pwd; printf '%s' \"a'b\"" }, "id", "/ignored");
	const remote = commandInvocation(command).args.at(-1)!;
	const result = spawnSync("/bin/sh", ["-c", remote], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /\/tmp\na'b$/);
});

test("reject dangerous or ambiguous metadata and terminal display controls", () => {
	for (const target of ["-oProxyCommand=bad", "a b", "host:/path", "a\nwhoami", "", "[::1]"]) {
		assert.throws(() => prepareCommand({ title: "Test", script: "true", target }, "CMD-1", "/tmp"));
	}
	for (const script of ["", "\x1b[2Jtrue", "true\rfalse", "echo \u202etest", "x".repeat(16001)]) {
		assert.throws(() => prepareCommand({ title: "Test", script }, "CMD-1", "/tmp"));
	}
	assert.throws(() => prepareCommand({ title: "Test", script: "true", cwd: "relative" }, "CMD-1", "/tmp"));
});
