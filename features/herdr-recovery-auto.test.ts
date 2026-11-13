import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";
import { readAutomaticSnapshot, registerHerdrRecoveryFeature, saveAutomaticEntry, type RecoveryEntry, type Terminal } from "./herdr-recovery.ts";

function entry(root: string, terminal = "t1", id = "session-1"): RecoveryEntry {
	return { terminal, space: "space", tab: `tab-${terminal}`, where: `Work / ${terminal}`, savedFile: false, reference: {
		version: 1, pid: process.pid, sessionId: id, sessionFile: join(root, `${id}.jsonl`), sessionDir: root,
		cwd: root, provider: "openai-codex", model: "model", thinking: "medium",
	} };
}
function directory(root: string, scope = "default") {
	return join(root, "automatic", encodeURIComponent(JSON.stringify([hostname(), scope])));
}

test("automatic records are private, isolated by terminal/session/core, deduplicated and sticky about saved files", async t => {
	const root = await mkdtemp(join(tmpdir(), "herdr-auto-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const saved = { ...entry(root), savedFile: true };
	await Promise.all([saveAutomaticEntry(root, "default", saved), saveAutomaticEntry(root, "default", entry(root, "t2"))]);
	const dir = directory(root);
	const initial = await Promise.all((await readdir(dir)).map(async file => [file, await readFile(join(dir, file), "utf8")]));
	await saveAutomaticEntry(root, "default", { ...saved, savedFile: false });
	for (const [file, content] of initial) {
		assert.equal(await readFile(join(dir, file), "utf8"), content, "unchanged records are not rewritten; savedFile cannot regress");
		assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
	}
	assert.equal((await stat(dir)).mode & 0o777, 0o700);
	assert.equal((await readAutomaticSnapshot(root, "default")).entries.length, 2);
	assert.equal((await readAutomaticSnapshot(root, "another-core")).entries.length, 0);
	// Set an unambiguously older timestamp without a timing-dependent test delay.
	for (const [file, content] of initial) {
		await writeFile(join(dir, file), JSON.stringify({ ...JSON.parse(content), createdAt: "2000-01-01T00:00:00.000Z" }));
	}
	await saveAutomaticEntry(root, "default", entry(root, "t1", "session-2"));
	assert.equal((await readdir(dir)).length, 3, "starting another session does not erase the original");
	const latest = await readAutomaticSnapshot(root, "default");
	assert.equal(latest.entries.find(e => e.terminal === "t1")?.reference.sessionId, "session-2");
	assert.equal(latest.entries.length, 2, "only latest per terminal is offered by default");
	for (const file of await readdir(dir)) {
		const record = JSON.parse(await readFile(join(dir, file), "utf8"));
		await writeFile(join(dir, file), JSON.stringify({ ...record, createdAt: "2001-01-01T00:00:00.000Z" }));
	}
	await saveAutomaticEntry(root, "default", saved, true);
	assert.equal((await readAutomaticSnapshot(root, "default")).entries.find(e => e.terminal === "t1")?.reference.sessionId, "session-1", "resuming an unchanged older session makes it current again");
});

test("corrupt or foreign records are reported and retained, not silently overwritten or restored", async t => {
	const root = await mkdtemp(join(tmpdir(), "herdr-auto-bad-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await saveAutomaticEntry(root, "default", entry(root));
	const dir = directory(root), file = join(dir, (await readdir(dir))[0]);
	const original = JSON.parse(await readFile(file, "utf8"));
	await writeFile(file, "broken");
	await assert.rejects(saveAutomaticEntry(root, "default", entry(root)));
	const broken = await readAutomaticSnapshot(root, "default");
	assert.equal(broken.entries.length, 0);
	assert.equal(broken.warnings.length, 1);
	assert.equal(await readFile(file, "utf8"), "broken");
	await writeFile(file, JSON.stringify({ ...original, host: "another-host" }));
	assert.equal((await readAutomaticSnapshot(root, "default")).entries.length, 0);
});

type Event = { reason?: string; message?: { role: string } };
test("lifecycle saves before shutdown, tracks settings and session switches, retries failure, and restore offers automatic first", async t => {
	const state = await mkdtemp(join(tmpdir(), "herdr-auto-events-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const root = join(state, "pi-adam", "herdr-recovery");
	const hooks = new Map<string, (event: Event, ctx: ExtensionContext) => Promise<void>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const notices: string[] = [], selections: string[][] = [];
	let session = "first", thinking = "medium", name = "First", fail = false;
	const labels: Terminal["labels"] = { "herdr.space": "space", "herdr.tab": "tab", where: "Work / one" };
	const calls: string[][] = [];
	const pi = createTestExtensionApi({
		on: (event: string, handler: (event: Event, ctx: ExtensionContext) => Promise<void>) => hooks.set(event, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command.handler),
		getThinkingLevel: () => thinking, getSessionName: () => name,
		exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (fail) throw new Error("core offline");
			if (args[0] === "label") labels["pi-adam.recovery"] = args[2].slice("pi-adam.recovery=".length);
			return { code: 0, stdout: JSON.stringify({ address: "t1", state: "live", pid: 1, parent: null, labels,
				foreground: { pid: process.pid, name: "node", argv: ["pi"] } }) };
		},
	});
	registerHerdrRecoveryFeature(pi, { HC_TERMINAL_ID: "t1", XDG_STATE_HOME: state });
	assert.equal(calls.length, 0, "factory has no side effects");
	const ctx = createTestExtensionContext({ mode: "tui", cwd: state, model: { provider: "provider", id: "model" }, sessionManager: {
		getSessionId: () => session, getSessionFile: () => join(state, `${session}.jsonl`), getSessionDir: () => state,
	}, ui: {
		notify: (message: string) => notices.push(message),
		select: async (_title: string, options: string[]) => { selections.push(options); return undefined; },
	} });
	await hooks.get("session_start")!({}, ctx);
	assert.equal((await readAutomaticSnapshot(root, "default")).entries[0].reference.sessionId, "first");
	thinking = "high"; name = "Updated";
	await hooks.get("thinking_level_select")!({}, ctx);
	await hooks.get("session_info_changed")!({}, ctx);
	assert.equal((await readAutomaticSnapshot(root, "default")).entries[0].reference.thinking, "high");
	assert.equal((await readAutomaticSnapshot(root, "default")).entries[0].reference.name, "Updated");
	await writeFile(join(state, "first.jsonl"), JSON.stringify({ type: "session", id: "first", cwd: state }));
	await hooks.get("message_end")!({ message: { role: "user" } }, ctx);
	assert.equal((await readAutomaticSnapshot(root, "default")).entries[0].savedFile, true);
	fail = true;
	await hooks.get("agent_settled")!({}, ctx);
	await hooks.get("agent_settled")!({}, ctx);
	assert.equal(notices.length, 1, "warn once per failure streak");
	await hooks.get("session_shutdown")!({}, ctx);
	assert.equal((await readAutomaticSnapshot(root, "default")).entries.length, 1, "no shutdown save or deletion needed");
	fail = false; session = "second";
	await hooks.get("session_start")!({ reason: "new" }, ctx);
	assert.equal((await readdir(directory(root))).length, 2);
	await commands.get("herdr-restore")!("", ctx);
	assert.match(selections[0][0], /^Automatic/);
	assert.equal(calls.filter(args => ["send", "keys"].includes(args[0])).length, 0, "auto saving never launches a session");
});

test("non-Herdr, remote-address and non-TUI instances never create records or inspect core", async () => {
	for (const environment of [{}, { HC_TERMINAL_ID: "remote/t1" }, { HC_TERMINAL_ID: "t1" }]) {
		const hooks = new Map<string, (event: Event, ctx: ExtensionContext) => Promise<void>>();
		const pi = createTestExtensionApi({ on: (event: string, handler: (event: Event, ctx: ExtensionContext) => Promise<void>) => hooks.set(event, handler), registerCommand() {}, exec() { assert.fail("must not inspect core"); } });
		registerHerdrRecoveryFeature(pi, { ...environment, XDG_STATE_HOME: join(homedir(), "must-not-write") });
		await hooks.get("session_start")!({}, createTestExtensionContext({ mode: "print" }));
	}
});
