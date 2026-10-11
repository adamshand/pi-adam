import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Parse } from "typebox/value";

const exec = promisify(execFile);
const Item = Type.Object({
	id: Type.String({ pattern: "^work_[a-f0-9]{24}$" }), title: Type.String(), description: Type.String(),
	state: Type.Union([Type.Literal("inbox"), Type.Literal("open"), Type.Literal("done"), Type.Literal("dropped")]),
	project: Type.Union([Type.Null(), Type.Object({ slug: Type.String() })]),
	source: Type.String(), revision: Type.Integer({ minimum: 1 }), created_at: Type.String(), updated_at: Type.String(),
});
const aliases = { "made": "haume-made", "haume.nz": "haume-nz", "wyrdness.haume.nz": "wyrdness", "kawhi": "haume-made" };
const cachedTokens = new Map();
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export class WorkError extends Error {
	constructor(message, status = 0) { super(message); this.status = status; }
}

async function jsonFile(path, fallback) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
async function atomicJson(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try { await durableWrite(temp, JSON.stringify(value)); await rename(temp, path); }
	finally { await rm(temp, { force: true }); }
}

async function durableWrite(path, content) {
	const file = await open(path, "w", 0o600);
	try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

/** Never steal locks: concurrent stale-lock reclamation can corrupt the outbox. */
export async function withWorkLock(path, operation) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const started = Date.now();
	while (true) {
		try { await mkdir(path); break; }
		catch (error) {
			if (error.code !== "EEXIST") throw error;
			if (Date.now() - started > 5000) throw new WorkError(`Work lock busy: ${path}. If its owner process has exited, remove the lock directory and retry.`);
			await wait(50);
		}
	}
	try { await atomicJson(join(path, "owner.json"), { pid: process.pid }); return await operation(); }
	finally { await rm(path, { recursive: true, force: true }); }
}

export function workDisplayId(item) { return `IDEA-${item.id.slice(-6)}`; }
export function workAge(createdAt) {
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 1000));
	return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
}
export function workDescription(intent = "", checklist = []) {
	const lines = [];
	for (const item of checklist) {
		lines.push(`- [${item.done ? "x" : " "}] ${item.text}`);
		for (const child of item.items ?? []) lines.push(`  - [${child.done ? "x" : " "}] ${child.text}`);
	}
	return [intent.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
}

export class WorkClient {
	constructor(options = {}) {
		this.env = options.env ?? process.env;
		const url = new URL(options.url ?? this.env.WORK_URL ?? "https://work.haume.nz");
		if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("WORK_URL must be an HTTPS origin (HTTP is allowed for localhost tests).");
		this.url = url.origin;
		this.stateDir = options.stateDir ?? join(this.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi-adam");
		this.timeout = options.timeout ?? 5000;
		this.tokenProvider = options.tokenProvider;
		this.scope = createHash("sha256").update(this.url).digest("hex").slice(0, 16);
		this.outbox = join(this.stateDir, "work-outbox.jsonl");
		this.lock = join(this.stateDir, "work-outbox.lock");
	}
	async token() {
		if (this.tokenProvider) return this.tokenProvider();
		const override = this.env.WORK_API_TOKEN || this.env.HAUME_WORK_API_TOKEN;
		if (override) return override;
		if (!cachedTokens.has(this.url)) {
			try {
				const { stdout } = await exec("security", ["find-generic-password", "-s", "work.haume.nz", "-w"], { timeout: this.timeout, maxBuffer: 16384 });
				cachedTokens.set(this.url, stdout.trim());
			} catch { throw new WorkError("Work credentials unavailable: set WORK_API_TOKEN or HAUME_WORK_API_TOKEN, or configure Keychain.", 401); }
		}
		return cachedTokens.get(this.url);
	}
	async request(path, method = "GET", body, key) {
		const token = await this.token();
		if (!token) throw new WorkError("Work API token is empty.", 401);
		let response;
		try {
			const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
			if (key) headers["Idempotency-Key"] = key;
			const options = { method, redirect: "error", signal: AbortSignal.timeout(this.timeout), headers };
			if (body !== undefined) options.body = JSON.stringify(body);
			response = await fetch(this.url + path, options);
			if (!response.ok) {
				if (response.status === 401) cachedTokens.delete(this.url);
				throw new WorkError(`Work ${method} failed (HTTP ${response.status}).`, response.status);
			}
			return await response.json();
		} catch (error) {
			if (error instanceof WorkError) throw error;
			throw new WorkError("Work unavailable or returned an invalid response; retry later.");
		}
	}
	async root(cwd) {
		try { return (await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: this.timeout })).stdout.trim(); }
		catch { return resolve(cwd); }
	}
	async project(cwd) {
		const root = await this.root(cwd);
		const config = await jsonFile(join(root, ".pi/work.json"), null);
		if (config !== null) {
			const parsed = Parse(Type.Object({ project: Type.Union([Type.String({ minLength: 1 }), Type.Null()]) }), config);
			return { root, project: parsed.project };
		}
		const cache = join(this.stateDir, `work-projects-${this.scope}.json`);
		let projects;
		try {
			const result = Parse(Type.Object({ projects: Type.Array(Type.Object({ slug: Type.String() })) }), await this.request("/api/v1/projects"));
			projects = result.projects;
			await atomicJson(cache, projects);
		} catch (error) {
			projects = await jsonFile(cache, null);
			if (!projects) throw error; // Don't silently capture into the wrong Project while offline.
		}
		const name = basename(root).replace(/\.git$/, "");
		const candidate = root.endsWith("/groundtruth/ansible") ? "groundtruth-ansible" : aliases[name] ?? name;
		return { root, project: projects.some((p) => p.slug === candidate) ? candidate : null };
	}
	cachePath(root, project) { return join(this.stateDir, `work-list-${this.scope}-${createHash("sha256").update(JSON.stringify([root, project])).digest("hex").slice(0, 16)}.json`); }
	async list(cwd) {
		const root = await this.root(cwd);
		let cachePath;
		let outboxError;
		try {
			await this.flush().catch((error) => { outboxError = error instanceof WorkError ? error.message : "Work outbox could not be flushed."; });
			const { project } = await this.project(cwd);
			cachePath = this.cachePath(root, project);
			const query = new URLSearchParams({ state: "inbox,open" });
			if (project) query.set("project", project);
			const result = Parse(Type.Object({ work_items: Type.Array(Item) }), await this.request(`/api/v1/work?${query}`));
			// An omitted project filter means ALL items to Work, not only unassigned ones.
			const items = result.work_items.filter((item) => (item.project?.slug ?? null) === project);
			const pending = (await this.entries()).filter((entry) => entry.url === this.url);
			const list = { items, project, stale: false, error: outboxError, fetchedAt: new Date().toISOString(), outbox: { pending: pending.length, blocked: pending.filter((entry) => entry.blocked).length, path: this.outbox } };
			await atomicJson(cachePath, list);
			return list;
		} catch (error) {
			const cached = cachePath ? await jsonFile(cachePath, null) : null;
			return { ...(cached ?? { items: [], project: null, fetchedAt: null }), stale: true, error: error instanceof WorkError ? error.message : "Work list unavailable." };
		}
	}
	async resolve(cwd, id) {
		const { project } = await this.project(cwd);
		if (/^work_[a-f0-9]{24}$/.test(id)) {
			const item = await this.get(id);
			if ((item.project?.slug ?? null) !== project) throw new WorkError("Work item belongs to another Project.");
			return item;
		}
		const list = await this.list(cwd);
		if (list.stale) throw new WorkError("Cannot resolve a short Idea ID from a stale list; retry online.");
		const suffix = id.replace(/^IDEA-/i, "").toLowerCase();
		if (!/^[a-f0-9]{6,24}$/.test(suffix)) throw new WorkError("Use IDEA-<last six hex digits> or a full work_ ID.");
		const matches = list.items.filter((item) => item.id.endsWith(suffix));
		if (matches.length !== 1) throw new WorkError(matches.length ? "Ambiguous Idea ID; use the full work_ ID." : "Idea not found in this Project.");
		return matches[0];
	}
	async get(id) { return Parse(Type.Object({ work_item: Item }), await this.request(`/api/v1/work/${encodeURIComponent(id)}`)).work_item; }
	async patch(id, changes) {
		return this.patchWith(id, () => changes);
	}
	async patchWith(id, makeChanges) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const current = await this.get(id);
			try {
				const patch = makeChanges(current);
				const result = Parse(Type.Object({ work_item: Item }), await this.request(`/api/v1/work/${id}`, "PATCH", { ...patch, revision: current.revision })).work_item;
				// A successful PATCH must not be reported as failed if outbox maintenance fails.
				await this.flush().catch(() => {});
				return result;
			} catch (error) { if (!(error instanceof WorkError) || error.status !== 409 || attempt === 2) throw error; }
		}
	}
	async entries() {
		try { return (await readFile(this.outbox, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
		catch (error) { if (error.code === "ENOENT") return []; throw error; }
	}
	async saveEntries(entries) {
		const temp = `${this.outbox}.${randomUUID()}.tmp`;
		try { await durableWrite(temp, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "")); await rename(temp, this.outbox); }
		finally { await rm(temp, { force: true }); }
	}
	receiptPath(key) { return join(this.stateDir, `work-receipt-${this.scope}-${key}.json`); }
	async deliver(entry) {
		if (!entry.payload) {
			const { project } = await this.project(entry.cwd);
			entry.payload = { ...entry.draft, project };
		}
		const response = Parse(Type.Object({ work_item: Item, replayed: Type.Boolean() }), await this.request("/api/v1/work", "POST", entry.payload, entry.key));
		await atomicJson(this.receiptPath(entry.key), { item: response.work_item, draft: entry.draft, cwd: entry.cwd });
		return response.work_item;
	}
	async flushLocked(entries, wantedKey) {
		let delivered;
		let changed = false;
		let attempts = 0;
		for (const entry of entries.slice()) {
			if (entry.url !== this.url || entry.blocked || attempts++ >= 10) continue;
			try {
				// Resolve and persist the EXACT payload before its first POST.
				if (!entry.payload) {
					const { project } = await this.project(entry.cwd);
					entry.payload = { ...entry.draft, project };
					await this.saveEntries(entries);
				}
				const item = await this.deliver(entry);
				entries.splice(entries.indexOf(entry), 1);
				changed = true;
				if (entry.key === wantedKey) delivered = item;
			} catch (error) {
				entry.error = error instanceof WorkError ? error.message : "Work capture failed.";
				if (error instanceof WorkError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) entry.blocked = true;
				changed = true;
				break;
			}
		}
		if (changed) await this.saveEntries(entries);
		return delivered;
	}
	async flush(retryBlocked = false) {
		return withWorkLock(this.lock, async () => {
			const entries = await this.entries();
			if (retryBlocked) for (const entry of entries) if (entry.url === this.url) entry.blocked = false;
			await this.flushLocked(entries);
		});
	}
	async create(cwd, values, key = randomUUID()) {
		if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key)) throw new WorkError("Invalid capture UUID.");
		const draft = { title: values.title.trim(), description: workDescription(values.intent, values.checklist), source: values.source ?? "agent" };
		if (!draft.title || draft.title.length > 200 || draft.description.length > 20000) throw new WorkError("Work title must be 1–200 characters and description at most 20000.", 400);
		return withWorkLock(this.lock, async () => {
			const root = await this.root(cwd);
			const checkCapture = (previous) => {
				if (JSON.stringify(previous.draft) !== JSON.stringify(draft) || previous.cwd !== root) throw new WorkError("Capture content changed after queuing. Todo retained: reconcile it with the outbox/receipt before retrying; never reuse a capture UUID for different content.", 409);
			};
			const receipt = await jsonFile(this.receiptPath(key), null);
			if (receipt) { checkCapture(receipt); return { item: await this.get(receipt.item.id), queued: false, key }; }
			const entries = await this.entries();
			let entry = entries.find((candidate) => candidate.key === key && candidate.url === this.url);
			if (entry) checkCapture(entry);
			if (!entry) {
				entry = { key, url: this.url, cwd: root, draft, createdAt: new Date().toISOString() };
				entries.push(entry);
				await this.saveEntries(entries);
			}
			const item = await this.flushLocked(entries, key);
			return item ? { item, queued: false, key } : { queued: true, key, blocked: Boolean(entry.blocked), error: entry.error ?? "Saved in Work outbox; awaiting delivery." };
		});
	}
}
