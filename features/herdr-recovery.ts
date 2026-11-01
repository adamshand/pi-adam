import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";

export const RECOVERY_LABEL = "pi-adam.recovery";
const Text = Type.String({ minLength: 1, pattern: "^[^\\x00-\\x1f\\x7f]+$" });
const ReferenceSchema = Type.Object({
	version: Type.Literal(1), pid: Type.Integer({ minimum: 1 }),
	sessionId: Text, sessionFile: Type.Optional(Text), sessionDir: Text, cwd: Text,
	provider: Type.Optional(Text), model: Type.Optional(Text), thinking: Type.Optional(Text),
	name: Type.Optional(Text),
});
const TerminalSchema = Type.Object({
	address: Text, state: Type.String(), pid: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	parent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	labels: Type.Record(Type.String(), Type.String()),
	foreground: Type.Optional(Type.Union([Type.Null(), Type.Object({
		pid: Type.Number(), name: Type.String(), argv: Type.Array(Type.String()),
	})])),
});
export type Terminal = Static<typeof TerminalSchema>;
export type Reference = Static<typeof ReferenceSchema>;
const EntrySchema = Type.Object({
	terminal: Text, space: Text, tab: Text, where: Text,
	reference: ReferenceSchema, savedFile: Type.Boolean(),
});
export type RecoveryEntry = Static<typeof EntrySchema>;
const SnapshotSchema = Type.Object({
	version: Type.Literal(1), host: Text, coreSession: Text, createdAt: Text,
	entries: Type.Array(EntrySchema), warnings: Type.Array(Type.String()),
});
export type RecoverySnapshot = Static<typeof SnapshotSchema>;
type Runner = (args: string[]) => Promise<string>;

export function liveReference(t: Terminal): Reference | undefined {
	if (t.state !== "live" || !t.foreground) return undefined;
	try {
		const ref = Parse(ReferenceSchema, JSON.parse(t.labels[RECOVERY_LABEL] || "null"));
		return ref.pid === t.foreground.pid ? ref : undefined;
	} catch { return undefined; }
}

export function recoveryCommand(entry: RecoveryEntry): string {
	const r = entry.reference;
	for (const path of [r.cwd, r.sessionDir, ...(r.sessionFile ? [r.sessionFile] : [])]) {
		if (!isAbsolute(path)) throw new Error("Recovery paths must be absolute");
	}
	if (!r.sessionFile) throw new Error("Ephemeral Pi sessions cannot be restored");
	const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
	// Fish single quotes escape backslash and apostrophe; never interpolate saved data.
	const args = entry.savedFile ? ["--session", r.sessionFile] : ["--session-id", r.sessionId];
	args.push("--session-dir", r.sessionDir);
	if (r.provider && r.model) args.push("--provider", r.provider, "--model", r.model);
	if (r.thinking) args.push("--thinking", r.thinking);
	if (r.name) args.push("--name", r.name);
	return `cd ${quote(r.cwd)} && pi ${args.map(quote).join(" ")}`;
}

function isUnidentifiedPi(t: Terminal): boolean {
	return t.state === "live" && !!t.foreground?.argv.some(arg => /(^|\/)pi(?:\.js)?$/.test(arg)) && !liveReference(t);
}

export type RestorePlan = { entry: RecoveryEntry; target?: Terminal; reason: string };
export function planRestore(entries: RecoveryEntry[], terminals: Terminal[], current: string, currentSession: string, launching: ReadonlySet<string> = new Set()): RestorePlan[] {
	const seen = new Set<string>();
	return entries.map(entry => {
		const id = entry.reference.sessionId;
		const targets = terminals.filter(t => t.labels["herdr.space"] === entry.space && t.labels["herdr.tab"] === entry.tab);
		// Terminal identity disambiguates split panes. Never fall back to an arbitrary pane.
		const exact = targets.find(t => t.address === entry.terminal);
		const target = exact || (targets.length === 1 ? targets[0] : undefined);
		let reason = "ready";
		if (seen.has(id)) reason = "duplicate snapshot session";
		else if (id === currentSession || terminals.some(t => liveReference(t)?.sessionId === id)) reason = "already running";
		else if (terminals.some(t => t.address !== current && !launching.has(t.address) && isUnidentifiedPi(t))) reason = "unidentified running Pi; reload it first to check duplicates";
		else if (!target) reason = "missing or ambiguous tab/pane";
		else if (target.address === current) reason = "current Pi terminal";
		else if (target.parent) reason = "child terminal";
		else if (target.state !== "live" || target.foreground?.name !== "fish" || target.foreground.pid !== target.pid) reason = "not an idle fish shell";
		seen.add(id);
		return { entry, target, reason };
	});
}

export async function inspectTerminals(run: Runner): Promise<Terminal[]> {
	const list = Parse(Type.Object({ terminals: Type.Array(Type.Object({ address: Text })) }), JSON.parse(await run(["ls"])));
	const terminals: Terminal[] = [];
	for (const { address } of list.terminals) {
		if (address.includes("/")) continue; // Never inspect or mutate remote machines.
		terminals.push(Parse(TerminalSchema, JSON.parse(await run(["get", address]))));
	}
	return terminals;
}

export async function captureSnapshot(terminals: Terminal[], coreSession: string): Promise<RecoverySnapshot> {
	const entries: RecoveryEntry[] = [], warnings: string[] = [];
	for (const t of terminals) {
		if (t.parent || !t.labels["herdr.tab"] || !t.labels["herdr.space"]) continue;
		const ref = liveReference(t);
		const where = t.labels.where || t.address;
		if (!ref) {
			if (isUnidentifiedPi(t)) warnings.push(`${where}: Pi has no current recovery metadata; run /reload there, then save again.`);
			continue;
		}
		if (!ref.sessionFile) { warnings.push(`${where}: ephemeral session cannot be resumed.`); continue; }
		let savedFile = true;
		try { await stat(ref.sessionFile); } catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			savedFile = false;
		}
		const entry = { terminal: t.address, space: t.labels["herdr.space"], tab: t.labels["herdr.tab"], where, reference: ref, savedFile };
		recoveryCommand(entry); // Validate before saving, not halfway through restore.
		entries.push(entry);
	}
	return { version: 1, host: hostname(), coreSession, createdAt: new Date().toISOString(), entries, warnings };
}

type LaunchClaim = { target: string; time: string; state: string };
async function atomicJson(path: string, value: RecoverySnapshot | LaunchClaim): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temp, path);
	} finally { await rm(temp, { force: true }); }
}

async function verifySession(entry: RecoveryEntry): Promise<boolean> {
	const r = entry.reference;
	if (!(await stat(r.cwd)).isDirectory()) throw new Error("Working directory is missing");
	if (!r.sessionFile) throw new Error("No session file");
	let file;
	try { file = await open(r.sessionFile, "r"); } catch (error) {
		if (!entry.savedFile && error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw new Error("Saved session file is missing or unreadable; refusing to create a replacement");
	}
	try {
		const buffer = Buffer.alloc(16384);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const header = Parse(Type.Object({ type: Type.Literal("session"), id: Text, cwd: Text }), JSON.parse(buffer.subarray(0, bytesRead).toString().split("\n")[0]));
		if (header.id !== r.sessionId || header.cwd !== r.cwd) throw new Error("Session identity/cwd differs from snapshot");
	} finally { await file.close(); }
	return true;
}

/** A durable claim precedes typing: an uncertain send must never be blindly retried. */
export async function restoreEntry(entry: RecoveryEntry, run: Runner, claims: string, current: string, currentSession: string, launching: Set<string> = new Set()): Promise<string> {
	await mkdir(claims, { recursive: true, mode: 0o700 });
	const savedFile = await verifySession(entry);
	const decision = planRestore([entry], await inspectTerminals(run), current, currentSession, launching)[0];
	if (decision.reason !== "ready" || !decision.target) return decision.reason;
	const target = decision.target;
	// A new shell after another restart can be restored again. The same shell
	// cannot receive a second launch after an uncertain send or failed startup.
	const claim = join(claims, `${encodeURIComponent(entry.reference.sessionId)}-${target.pid}.json`);
	try { await stat(claim); return "previous launch attempt recorded; inspect the tab before retrying"; }
	catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
	// Across concurrent /herdr-restore invocations, only one may claim this session.
	await writeFile(claim, JSON.stringify({ target: target.address, time: new Date().toISOString(), state: "attempting" }), { flag: "wx", mode: 0o600 });
	// Clear pending shell input only after explicit confirmation. Never press Enter on it.
	await run(["keys", target.address, "ctrl+c"]);
	const fresh = Parse(TerminalSchema, JSON.parse(await run(["get", target.address])));
	if (fresh.pid !== target.pid || fresh.foreground?.pid !== target.foreground?.pid ||
		planRestore([entry], [fresh], current, currentSession)[0].reason !== "ready") {
		return "terminal changed before launch; no command sent";
	}
	await run(["send", target.address, recoveryCommand({ ...entry, savedFile })]);
	// This invocation knows what it just launched. Startup can take a few seconds
	// before Pi publishes metadata; do not let that block all remaining tabs.
	launching.add(target.address);
	await atomicJson(claim, { target: target.address, time: new Date().toISOString(), state: "sent" });
	return "launch command sent (no task submitted)";
}

export function registerHerdrRecoveryFeature(pi: ExtensionAPI, environment: NodeJS.ProcessEnv = process.env): void {
	const terminal = environment.HC_TERMINAL_ID;
	const coreSession = environment.HC_SESSION || "default";
	const root = join(environment.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-adam", "herdr-recovery");
	const run: Runner = async args => {
		const result = await pi.exec("hc", args, { timeout: 5000 });
		if (result.code !== 0) throw new Error(`hc ${args[0]} failed (exit ${result.code})`);
		return result.stdout;
	};
	let pending = Promise.resolve();
	let published: string | undefined;
	const publish = (ctx: ExtensionContext): Promise<void> => {
		if (!terminal || ctx.mode !== "tui") return Promise.resolve();
		const reference: Reference = {
			version: 1, pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(), sessionDir: ctx.sessionManager.getSessionDir(),
			cwd: ctx.cwd, provider: ctx.model?.provider, model: ctx.model?.id,
			thinking: pi.getThinkingLevel(), name: pi.getSessionName() || undefined,
		};
		const value = JSON.stringify(reference);
		pending = pending.then(async () => {
			if (value === published) return;
			const t = Parse(TerminalSchema, JSON.parse(await run(["get", terminal])));
			if (!t.labels["herdr.tab"]) return;
			await run(["label", terminal, `${RECOVERY_LABEL}=${value}`]);
			published = value;
		}).catch(() => { /* Optional bridge; commands report missing metadata explicitly. */ });
		return pending;
	};
	pi.on("session_start", (_event, ctx) => publish(ctx));
	pi.on("model_select", (_event, ctx) => publish(ctx));
	pi.on("thinking_level_select", (_event, ctx) => publish(ctx));
	pi.on("session_info_changed", (_event, ctx) => publish(ctx));
	pi.on("agent_settled", (_event, ctx) => publish(ctx));
	pi.on("session_shutdown", async () => {
		await pending;
		if (!terminal || !published) return;
		try {
			const t = Parse(TerminalSchema, JSON.parse(await run(["get", terminal])));
			if (t.labels[RECOVERY_LABEL] === published) await run(["label", terminal, `${RECOVERY_LABEL}=`]);
		} catch { /* Core may already be stopped. PID validation rejects stale labels. */ }
		published = undefined;
	});
	const available = (ctx: ExtensionContext): boolean => {
		if (ctx.mode === "tui" && terminal && !terminal.includes("/")) return true;
		ctx.ui.notify("Use this command in a local Herdr Pi terminal.", "warning");
		return false;
	};
	pi.registerCommand("herdr-save", {
		description: "Save local Herdr Pi sessions for restart recovery",
		handler: async (_args, ctx) => {
			if (!available(ctx)) return;
			try {
				await publish(ctx);
				const snapshot = await captureSnapshot(await inspectTerminals(run), coreSession);
				if (!snapshot.entries.length) throw new Error(`No recoverable Pi sessions. ${snapshot.warnings.join("\n")}`);
				if (snapshot.warnings.length && !await ctx.ui.confirm("Save a partial Herdr snapshot?", snapshot.warnings.join("\n"))) return;
				const file = join(root, `${Date.now()}-${randomUUID()}.json`);
				await atomicJson(file, snapshot);
				ctx.ui.notify(`Saved ${snapshot.entries.length} Pi sessions to ${file}`, "info");
			} catch (error) { ctx.ui.notify(`Herdr save: ${String(error)}`, "error"); }
		},
	});
	pi.registerCommand("herdr-restore", {
		description: "Preview and restore saved Pi sessions into their Herdr tabs",
		handler: async (_args, ctx) => {
			if (!available(ctx) || !terminal) return;
			try {
				await publish(ctx);
				await mkdir(root, { recursive: true, mode: 0o700 });
				const files = (await readdir(root)).filter(f => /^\d+-[\da-f-]+\.json$/.test(f)).sort().reverse();
				if (!files.length) throw new Error("No snapshots yet; run /herdr-save before restarting.");
				const choices = files.map(file => `${new Date(Number(file.split("-")[0])).toLocaleString()} — ${file}`);
				const choice = await ctx.ui.select("Herdr snapshot (newest first)", choices);
				if (!choice) return;
				const selected = files[choices.indexOf(choice)];
				if (!selected) return;
				const snapshot = Parse(SnapshotSchema, JSON.parse(await readFile(join(root, selected), "utf8")));
				if (snapshot.host !== hostname() || snapshot.coreSession !== coreSession) throw new Error("Snapshot belongs to another host or HC_SESSION");
				const plan = planRestore(snapshot.entries, await inspectTerminals(run), terminal, ctx.sessionManager.getSessionId());
				const preview = plan.map(p => `${p.entry.where}: ${p.reason}${!p.entry.savedFile ? " (empty session)" : ""}`).join("\n");
				if (!plan.some(p => p.reason === "ready")) { ctx.ui.notify(preview || "Empty snapshot", "info"); return; }
				if (!await ctx.ui.confirm("Restore Herdr Pi sessions?", `${preview}\n\nClears pending input in target fish shells. Leave those tabs untouched during restore. No tasks are resent; missing tabs and child/remote terminals are skipped.`)) return;
				const scope = join(root, "launch-claims", encodeURIComponent(`${hostname()}-${coreSession}`));
				await mkdir(scope, { recursive: true, mode: 0o700 });
				const lock = join(scope, "restore.lock");
				try { await mkdir(lock, { mode: 0o700 }); }
				catch { throw new Error(`Restore already active or interrupted. Inspect ${lock} before removing it.`); }
				const results: string[] = [];
				const launching = new Set<string>();
				try {
					await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, time: new Date().toISOString() }), { mode: 0o600 });
					for (const p of plan.filter(p => p.reason === "ready")) {
						try {
							results.push(`${p.entry.where}: ${await restoreEntry(p.entry, run, scope, terminal, ctx.sessionManager.getSessionId(), launching)}`);
						} catch (error) { results.push(`${p.entry.where}: ${String(error)} (inspect before retrying)`); }
					}
				} finally { await rm(lock, { recursive: true, force: true }); }
				ctx.ui.notify(results.join("\n"), "info");
			} catch (error) { ctx.ui.notify(`Herdr restore: ${String(error)}`, "error"); }
		},
	});
}
