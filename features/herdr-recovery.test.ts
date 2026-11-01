import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
	captureSnapshot, inspectTerminals, liveReference, planRestore, recoveryCommand,
	RECOVERY_LABEL, registerHerdrRecoveryFeature, restoreEntry,
	type RecoveryEntry, type Reference, type Terminal,
} from "./herdr-recovery.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const reference: Reference = {
	version: 1, pid: 42, sessionId: "session-123", sessionFile: "/project/sessions/test.jsonl",
	sessionDir: "/project/sessions", cwd: "/project", provider: "openai-codex", model: "gpt-6-astra", thinking: "medium",
};
const entry: RecoveryEntry = { terminal: "t1", space: "space1", tab: "tab1", where: "Work / project", reference, savedFile: true };
function shell(address = "t1"): Terminal {
	return { address, state: "live", pid: 10, parent: null, labels: { "herdr.space": "space1", "herdr.tab": "tab1" }, foreground: { pid: 10, name: "fish", argv: ["/bin/fish"] } };
}
function agent(address = "t1", ref = reference): Terminal {
	return { ...shell(address), foreground: { pid: ref.pid, name: "node", argv: ["pi", ""] }, labels: { ...shell(address).labels, [RECOVERY_LABEL]: JSON.stringify(ref) } };
}

test("metadata must belong to the live foreground process, not a stale terminal label", () => {
	assert.equal(liveReference(agent())?.sessionId, reference.sessionId);
	assert.equal(liveReference({ ...agent(), foreground: shell().foreground }), undefined);
	assert.equal(liveReference({ ...agent(), state: "finished" }), undefined);
	assert.equal(liveReference({ ...agent(), labels: { [RECOVERY_LABEL]: "broken" } }), undefined);
});

test("plan matches stable tab labels, avoids duplicates, and never hijacks current or busy panes", () => {
	const plan = (ts: Terminal[], current = "t99", session = "other") => planRestore([entry], ts, current, session)[0];
	assert.equal(plan([shell()]).reason, "ready");
	assert.equal(plan([shell("t8")]).target?.address, "t8");
	assert.equal(plan([shell("t8"), shell("t9")]).reason, "missing or ambiguous tab/pane");
	assert.equal(plan([{ ...shell(), labels: {} }]).reason, "missing or ambiguous tab/pane");
	assert.equal(plan([shell()], "t1").reason, "current Pi terminal");
	assert.equal(plan([shell()], "t99", reference.sessionId).reason, "already running");
	assert.equal(plan([agent()]).reason, "already running");
	assert.equal(plan([agent("t8"), shell()]).reason, "already running");
	assert.equal(plan([agent("t1", { ...reference, sessionId: "different" })]).reason, "not an idle fish shell");
	assert.equal(plan([{ ...shell(), parent: "t99" }]).reason, "child terminal");
	assert.equal(plan([{ ...shell(), foreground: { pid: 33, name: "fish", argv: ["fish"] } }]).reason, "not an idle fish shell");
	assert.equal(planRestore([entry, entry], [shell()], "t99", "other")[1].reason, "duplicate snapshot session");
	const unidentified = { ...agent("t8"), labels: {} };
	assert.match(plan([shell(), unidentified]).reason, /unidentified running Pi/);
	assert.equal(planRestore([entry], [shell(), unidentified], "t99", "other", new Set(["t8"]))[0].reason, "ready", "our own booting Pi does not block the next tab");
});

test("commands use exact files, provider-qualified models, and fish-safe quoting", () => {
	assert.match(recoveryCommand(entry), /--session' '\/project\/sessions\/test.jsonl/);
	assert.match(recoveryCommand(entry), /--provider' 'openai-codex' '--model' 'gpt-6-astra/);
	assert.doesNotMatch(recoveryCommand(entry), /--continue/);
	assert.match(recoveryCommand({ ...entry, savedFile: false }), /--session-id' 'session-123' '--session-dir/);
	assert.throws(() => recoveryCommand({ ...entry, reference: { ...reference, cwd: "relative" } }), /absolute/);
	assert.throws(() => recoveryCommand({ ...entry, reference: { ...reference, sessionFile: undefined } }), /Ephemeral/);
});

test("fish quoting prevents execution of path/name metacharacters", async t => {
	let fish: string;
	try { fish = execFileSync("which", ["fish"], { encoding: "utf8" }).trim(); } catch { t.skip("fish unavailable"); return; }
	const root = await mkdtemp(join(tmpdir(), "herdr-quote-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "it's \\ $HOME (echo bad); hi");
	await mkdir(cwd);
	const name = "quote' \\ $USER (exit 9); # end";
	const command = recoveryCommand({ ...entry, reference: { ...reference, cwd, name } });
	const output = execFileSync(fish, ["--no-config", "-c", `function pi; printf '%s\\n' $argv; end; ${command}`], { encoding: "utf8" });
	assert.equal(output.trim().split("\n").at(-1), name);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "herdr-recovery-"));
	const ref = { ...reference, cwd: root, sessionDir: root, sessionFile: join(root, "session.jsonl") };
	await writeFile(ref.sessionFile, JSON.stringify({ type: "session", id: ref.sessionId, cwd: root }) + "\n");
	return { root, ref, saved: { ...entry, reference: ref }, claims: join(root, "claims") };
}

test("capture includes only top-level local tab Pi references, and flags missing metadata", async t => {
	const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
	const snapshot = await captureSnapshot([
		agent("t1", f.ref), shell("t2"), { ...agent("t3", f.ref), parent: "t1" },
		{ ...agent("t4", f.ref), labels: {} },
		{ ...agent("t5", f.ref), labels: shell().labels },
		agent("t6", { ...f.ref, sessionFile: undefined }),
		agent("t7", { ...f.ref, sessionFile: join(f.root, "empty.jsonl") }),
	], "default");
	assert.deepEqual(snapshot.entries.map(e => [e.terminal, e.savedFile]), [["t1", true], ["t7", false]]);
	assert.equal(snapshot.warnings.length, 2);
	assert.match(snapshot.warnings[0], /reload/);
	assert.match(snapshot.warnings[1], /ephemeral/);
});

test("inspection excludes remote machines", async () => {
	const calls: string[][] = [];
	const result = await inspectTerminals(async args => {
		calls.push(args);
		return JSON.stringify(args[0] === "ls" ? { terminals: [{ address: "t1" }, { address: "remote/t1" }] } : shell());
	});
	assert.equal(result.length, 1);
	assert.deepEqual(calls, [["ls"], ["get", "t1"]]);
});

test("restore checks files and foreground, sends once, and protects uncertain retries", async t => {
	const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
	const calls: string[][] = [];
	let currentShell = shell();
	const run = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "ls") return JSON.stringify({ terminals: [{ address: "t1" }] });
		if (args[0] === "get") return JSON.stringify(currentShell);
		return "{}";
	};
	assert.match(await restoreEntry(f.saved, run, f.claims, "t99", "other"), /command sent/);
	assert.deepEqual(calls.filter(c => c[0] === "keys"), [["keys", "t1", "ctrl+c"]]);
	assert.equal(calls.filter(c => c[0] === "send").length, 1);
	assert.match(await restoreEntry(f.saved, run, f.claims, "t99", "other"), /previous launch/);
	assert.equal(calls.filter(c => c[0] === "send").length, 1);
	// A genuinely new shell after a later core stop can use the snapshot again.
	currentShell = { ...shell(), pid: 20, foreground: { ...shell().foreground!, pid: 20 } };
	assert.match(await restoreEntry(f.saved, run, f.claims, "t99", "other"), /command sent/);
	assert.equal(calls.filter(c => c[0] === "send").length, 2);
});

test("missing or replaced saved files fail closed; empty sessions that gained a file use that file", async t => {
	const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
	const sends: string[][] = [];
	const run = async (args: string[]) => {
		if (args[0] === "ls") return JSON.stringify({ terminals: [{ address: "t1" }] });
		if (args[0] === "get") return JSON.stringify(shell());
		sends.push(args); return "{}";
	};
	await writeFile(f.ref.sessionFile, JSON.stringify({ type: "session", id: "wrong", cwd: f.root }));
	await assert.rejects(restoreEntry(f.saved, run, f.claims, "t99", "other"), /identity/);
	await rm(f.ref.sessionFile);
	await assert.rejects(restoreEntry(f.saved, run, f.claims, "t99", "other"), /missing/);
	assert.equal(sends.length, 0);
	await writeFile(f.ref.sessionFile, JSON.stringify({ type: "session", id: f.ref.sessionId, cwd: f.root }));
	await restoreEntry({ ...f.saved, savedFile: false }, run, f.claims, "t99", "other");
	assert.match(sends.find(c => c[0] === "send")![2], /--session'/);
});

test("foreground changes between preview and send prevent typing a launch", async t => {
	const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
	let gets = 0, sent = false;
	const run = async (args: string[]) => {
		if (args[0] === "ls") return JSON.stringify({ terminals: [{ address: "t1" }] });
		if (args[0] === "get") return JSON.stringify(++gets === 1 ? shell() : agent());
		if (args[0] === "send") sent = true;
		return "{}";
	};
	assert.match(await restoreEntry(f.saved, run, f.claims, "t99", "other"), /changed/);
	assert.equal(sent, false);
});

test("failed sends leave durable claims, not automatic retries", async t => {
	const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
	let sends = 0;
	const run = async (args: string[]) => {
		if (args[0] === "ls") return JSON.stringify({ terminals: [{ address: "t1" }] });
		if (args[0] === "get") return JSON.stringify(shell());
		if (args[0] === "send") { sends++; throw new Error("disconnected"); }
		return "{}";
	};
	await assert.rejects(restoreEntry(f.saved, run, f.claims, "t99", "other"), /disconnected/);
	assert.match(await restoreEntry(f.saved, run, f.claims, "t99", "other"), /previous launch/);
	assert.equal(sends, 1);
	const claim = JSON.parse(await readFile(join(f.claims, (await readdir(f.claims))[0]), "utf8"));
	assert.equal(claim.state, "attempting");
});

test("extension registers manual commands and publishes owned metadata only in Herdr TUI", async () => {
	const handlers = new Map<string, (event: { reason?: string }, ctx: ExtensionContext) => Promise<void>>();
	const commands: string[] = [], calls: string[][] = [];
	const pi = createTestExtensionApi({
		on: (name: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
		registerCommand: (name: string) => commands.push(name),
		getThinkingLevel: () => "medium", getSessionName: () => "Project",
		exec: async (_command: string, args: string[]) => { calls.push(args); return { code: 0, stdout: JSON.stringify(shell()) }; },
	});
	registerHerdrRecoveryFeature(pi, { HC_TERMINAL_ID: "t1" });
	assert.deepEqual(commands, ["herdr-save", "herdr-restore"]);
	assert.equal(calls.length, 0);
	const ctx = createTestExtensionContext({ mode: "tui", cwd: "/project", model: { id: "model", provider: "provider" }, sessionManager: {
		getSessionId: () => "session", getSessionFile: () => "/project/session.jsonl", getSessionDir: () => "/project",
	} });
	await handlers.get("session_start")!({}, ctx);
	assert.match(calls[1][2], /pi-adam.recovery=/);
	assert.match(calls[1][2], /"provider":"provider"/);
	await handlers.get("session_start")!({}, ctx);
	assert.equal(calls.length, 2, "unchanged publications are deduplicated");
});

test("slash commands save privately, preview before mutation, and leave current Pi alone", async t => {
	const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const calls: string[][] = [], notices: string[] = [], confirmations: string[] = [];
	let allow = true;
	const current = agent("t99", { ...f.ref, pid: process.pid, sessionId: "bootstrap" });
	current.labels["herdr.tab"] = "bootstrap-tab";
	let target = agent("t1", f.ref);
	const pi = createTestExtensionApi({
		on() {}, getThinkingLevel: () => "medium", getSessionName: () => "Bootstrap",
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command.handler),
		exec: async (_cmd: string, args: string[]) => {
			calls.push(args);
			let stdout = "{}";
			if (args[0] === "ls") stdout = JSON.stringify({ terminals: [{ address: "t1" }, { address: "t99" }] });
			if (args[0] === "get") stdout = JSON.stringify(args[1] === "t99" ? current : target);
			if (args[0] === "label") current.labels[RECOVERY_LABEL] = args[2].slice(RECOVERY_LABEL.length + 1);
			return { code: 0, stdout };
		},
	});
	registerHerdrRecoveryFeature(pi, { HC_TERMINAL_ID: "t99", XDG_STATE_HOME: f.root });
	const root = join(f.root, "pi-adam", "herdr-recovery");
	const ctx = createTestExtensionContext({
		mode: "tui", cwd: f.root, model: { provider: "openai-codex", id: "gpt-6-astra" },
		sessionManager: { getSessionId: () => "bootstrap", getSessionFile: () => join(f.root, "bootstrap.jsonl"), getSessionDir: () => f.root },
		ui: {
			notify: (message: string) => notices.push(message),
			confirm: async (_title: string, message: string) => { confirmations.push(message); return allow; },
			select: async (_title: string, options: string[]) => options[0],
		},
	});
	await commands.get("herdr-save")!("", ctx);
	assert.match(notices.at(-1)!, /Saved 2 Pi sessions/);
	const files = await readdir(root);
	assert.equal(files.length, 1);
	const saved = JSON.parse(await readFile(join(root, files[0]), "utf8"));
	assert.equal(saved.entries.length, 2);
	const { stat } = await import("node:fs/promises");
	assert.equal((await stat(join(root, files[0]))).mode & 0o777, 0o600);
	assert.equal((await stat(root)).mode & 0o777, 0o700);
	target = shell(); allow = false;
	await commands.get("herdr-restore")!("", ctx);
	assert.match(confirmations.at(-1)!, /already running/);
	assert.equal(calls.filter(c => c[0] === "send" || c[0] === "keys").length, 0);
	allow = true;
	await commands.get("herdr-restore")!("", ctx);
	assert.equal(calls.filter(c => c[0] === "send").length, 1);
	assert.equal(calls.find(c => c[0] === "send")![1], "t1");
	assert.match(notices.at(-1)!, /launch command sent/);
});

