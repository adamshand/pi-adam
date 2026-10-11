import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import { Check, Parse } from "typebox/value";

const ChecklistEntrySchema = Type.Object({
	text: Type.Optional(Type.String()),
	done: Type.Optional(Type.Boolean()),
	items: Type.Optional(Type.Array(Type.Unknown())),
});

const WorkItemFileSchema = Type.Object({
	id: Type.Optional(Type.String()),
	revision: Type.Optional(Type.Integer({ minimum: 1 })),
	kind: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	intent: Type.Optional(Type.String()),
	progress: Type.Optional(Type.String()),
	checklist: Type.Optional(Type.Array(Type.Unknown())),
	status: Type.Optional(Type.String()),
	owner_session_id: Type.Optional(Type.String()),
	created_in_session_id: Type.Optional(Type.String()),
	created_at: Type.Optional(Type.String()),
	updated_at: Type.Optional(Type.String()),
	work_id: Type.Optional(Type.String({ pattern: "^work_[a-f0-9]{24}$" })),
	work_url: Type.Optional(Type.String()),
	work_capture_key: Type.Optional(Type.String()),
});

const LegacyMetadataSchema = Type.Object({
	id: Type.Optional(Type.String()),
	kind: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	status: Type.Optional(Type.String()),
	owner_session_id: Type.Optional(Type.String()),
	created_in_session_id: Type.Optional(Type.String()),
	origin_session_id: Type.Optional(Type.String()),
	assigned_to_session: Type.Optional(Type.String()),
	created_at: Type.Optional(Type.String()),
	updated_at: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Array(Type.String())),
});

export const SCHEMA_VERSION = 2;
export const TODO_STATUSES = ["ready", "in_progress", "done"];

export function normalizeWorkItemId(value) {
	let id = String(value ?? "").trim();
	if (id.startsWith("#")) id = id.slice(1);
	if (/^(TODO|IDEA)-/i.test(id)) id = id.replace(/^(TODO|IDEA)-/i, "");
	return id;
}

export function normalizeTodoStatus(value) {
	const status = String(value ?? "ready").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
	if (["done", "closed", "complete", "completed"].includes(status)) return "done";
	if (["in_progress", "started", "active", "working"].includes(status)) return "in_progress";
	if (["ready", "open", "new", "pending", "todo", "outstanding", "not_started"].includes(status)) return "ready";
	return "ready";
}

export function normalizeChecklist(items) {
	if (!Array.isArray(items)) return [];
	return items.flatMap((item) => {
		if (!Check(ChecklistEntrySchema, item)) return [];
		const text = String(item.text ?? "").trim();
		if (!text) return [];
		const children = normalizeChecklist(item.items);
		return [{ text, ...(children.length > 0 ? { items: children } : { done: Boolean(item.done) }) }];
	});
}

export function checklistProgress(items) {
	let done = 0;
	let total = 0;
	for (const item of normalizeChecklist(items)) {
		if (item.items) {
			const child = checklistProgress(item.items);
			done += child.done;
			total += child.total;
		} else {
			total += 1;
			if (item.done) done += 1;
		}
	}
	return { done, total };
}

export function isCompleted(item) {
	return item.kind === "todo" && normalizeTodoStatus(item.status) === "done";
}

export function workItemsDirectory(cwd) {
	return join(cwd, ".pi", "work-items"); // Legacy per-Todo files, read only for migration.
}

export function sessionTodoPath(cwd, sessionId) {
	const name = sessionId ? encodeURIComponent(sessionId).replaceAll(".", "%2E").replaceAll("_", "%5F") : "_unowned";
	return join(cwd, ".pi", "todos", `${name}.json`);
}

function decodeItem(data, path) {
	const kind = data.kind === "idea" ? "idea" : "todo";
	return {
		path, id: String(data.id ?? basename(path, ".json")), kind,
		revision: data.revision ?? 1,
		title: String(data.title ?? "Untitled"),
		intent: data.intent ?? "", progress: data.progress ?? "",
		checklist: normalizeChecklist(data.checklist),
		status: kind === "todo" ? normalizeTodoStatus(data.status) : undefined,
		ownerSessionId: kind === "todo" ? data.owner_session_id : undefined,
		createdInSessionId: data.created_in_session_id,
		createdAt: String(data.created_at ?? ""),
		updatedAt: String(data.updated_at ?? data.created_at ?? ""),
		workId: data.work_id, workUrl: data.work_url, workCaptureKey: data.work_capture_key,
	};
}

export function readWorkItem(path) {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (raw.todos !== undefined) return undefined; // Not a legacy single-item file.
		return decodeItem(Parse(WorkItemFileSchema, raw), path);
	} catch { return undefined; }
}

function encodeItem(item) {
	const createdAt = item.createdAt || new Date().toISOString();
	const data = {
		id: normalizeWorkItemId(item.id), kind: "todo", revision: item.revision ?? 1,
		title: String(item.title ?? "Untitled"),
		created_at: createdAt, updated_at: item.updatedAt || createdAt,
		status: normalizeTodoStatus(item.status),
		checklist: normalizeChecklist(item.checklist),
	};
	if (item.intent) data.intent = String(item.intent);
	if (item.progress) data.progress = String(item.progress);
	if (item.ownerSessionId) data.owner_session_id = item.ownerSessionId;
	if (item.createdInSessionId) data.created_in_session_id = item.createdInSessionId;
	if (item.workId) data.work_id = item.workId;
	if (item.workUrl) data.work_url = item.workUrl;
	if (item.workCaptureKey) data.work_capture_key = item.workCaptureKey;
	return data;
}

const SessionFileSchema = Type.Object({
	schema_version: Type.Literal(SCHEMA_VERSION),
	session_id: Type.Union([Type.String(), Type.Null()]),
	updated_at: Type.String(),
	todos: Type.Array(Type.Intersect([WorkItemFileSchema, Type.Object({
		id: Type.String({ minLength: 1 }), kind: Type.Literal("todo"),
		title: Type.String(), revision: Type.Integer({ minimum: 1 }),
	})])),
});

function readSession(path) {
	let raw;
	try { raw = JSON.parse(readFileSync(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
	// Fail closed: malformed session files must never be overwritten as empty plans.
	if (!Check(SessionFileSchema, raw)) throw new Error(`Invalid Todo session file: ${path}`);
	const ids = new Set();
	for (const todo of raw.todos) {
		if ((todo.owner_session_id ?? null) !== raw.session_id || ids.has(todo.id)) throw new Error(`Invalid Todo ownership or duplicate ID: ${path}`);
		ids.add(todo.id);
	}
	const cwd = dirname(dirname(dirname(path)));
	if (path !== sessionTodoPath(cwd, raw.session_id)) throw new Error(`Todo session filename does not match its owner: ${path}`);
	return raw.todos.map((data) => decodeItem(data, path));
}

function atomicWrite(path, data) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		try { writeFileSync(fd, JSON.stringify(data, null, 2) + "\n"); fsyncSync(fd); }
		finally { closeSync(fd); }
		renameSync(temp, path);
	} finally { rmSync(temp, { force: true }); }
}

function saveSession(path, todos, sessionId) {
	atomicWrite(path, {
		schema_version: SCHEMA_VERSION, session_id: sessionId ?? null,
		updated_at: new Date().toISOString(), todos: todos.map(encodeItem),
	});
}

// Short synchronous read-modify-write transactions shared by Pi and the board.
// Never hold this lock during network calls; never steal another writer's lock.
function withStoreLock(cwd, operation) {
	const lock = join(cwd, ".pi", "todos.lock");
	mkdirSync(dirname(lock), { recursive: true });
	const started = Date.now();
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	while (true) {
		try { mkdirSync(lock); break; }
		catch (error) {
			if (error.code !== "EEXIST") throw error;
			if (Date.now() - started > 2000) throw new Error(`Todo store busy: ${lock}. Retry; if the owner process exited, remove this lock directory.`);
			Atomics.wait(sleeper, 0, 0, 10);
		}
	}
	try {
		writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
		return operation();
	} finally { rmSync(lock, { recursive: true, force: true }); }
}

function jsonPaths(directory) {
	try { return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => join(directory, name)); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function sessionTodos(cwd) {
	return jsonPaths(join(cwd, ".pi", "todos")).flatMap(readSession);
}

function legacyItems(cwd) {
	return jsonPaths(workItemsDirectory(cwd)).map(readWorkItem).filter(Boolean);
}

function migrateJsonUnlocked(cwd) {
	const migrated = [];
	for (const old of legacyItems(cwd).filter((item) => item.kind === "todo")) {
		const path = sessionTodoPath(cwd, old.ownerSessionId);
		const todos = readSession(path);
		const existing = todos.find((todo) => todo.id === old.id);
		if (existing && JSON.stringify(encodeItem(existing)) !== JSON.stringify(encodeItem({ ...old, createdAt: old.createdAt || existing.createdAt, updatedAt: old.updatedAt || existing.updatedAt }))) {
			throw new Error(`Conflicting Todo migration for ${old.id}; both files retained: ${old.path}, ${path}`);
		}
		if (!existing) {
			todos.push({ ...old, path });
			saveSession(path, todos, old.ownerSessionId);
		}
		// Destination was atomically saved before removing the old per-item file.
		unlinkSync(old.path);
		migrated.push({ item: { ...old, path }, sourcePath: old.path });
	}
	return migrated;
}

export function listWorkItems(cwd) {
	const todos = sessionTodos(cwd);
	const legacy = legacyItems(cwd).filter((item) => item.kind === "todo" && !todos.some((todo) => todo.id === item.id && todo.ownerSessionId === item.ownerSessionId));
	return [...todos, ...legacy].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function listTodos(cwd, options = {}) {
	return listWorkItems(cwd).filter((item) => item.kind === "todo" && (options.sessionId === undefined || item.ownerSessionId === options.sessionId));
}

export function getWorkItem(cwd, id) {
	const matches = listWorkItems(cwd).filter((item) => item.id === normalizeWorkItemId(id));
	if (matches.length > 1) throw new Error(`Ambiguous local Todo ID: ${id}`);
	return matches[0];
}

function nextId(cwd) {
	let id;
	do id = randomBytes(4).toString("hex"); while (getWorkItem(cwd, id));
	return id;
}

function createUnlocked(cwd, options) {
	const now = new Date().toISOString();
	const requestedId = normalizeWorkItemId(options.id);
	const id = requestedId && !getWorkItem(cwd, requestedId) ? requestedId : nextId(cwd);
	const path = sessionTodoPath(cwd, options.ownerSessionId);
	const item = decodeItem(encodeItem({ ...options, id, revision: 1, createdAt: options.createdAt || now, updatedAt: options.updatedAt || options.createdAt || now }), path);
	const todos = readSession(path);
	todos.push(item);
	saveSession(path, todos, item.ownerSessionId);
	return item;
}

export function createWorkItem(cwd, options) {
	if (options.kind !== "todo") throw new Error("Ideas live in Work; local Idea writes are disabled.");
	return withStoreLock(cwd, () => { migrateJsonUnlocked(cwd); return createUnlocked(cwd, options); });
}

export function createTodo(cwd, options) {
	return createWorkItem(cwd, { ...options, kind: "todo" });
}

function mutateTodo(cwd, id, change) {
	return withStoreLock(cwd, () => {
		migrateJsonUnlocked(cwd);
		const item = getWorkItem(cwd, id);
		if (!item || item.kind !== "todo") return undefined;
		const todos = readSession(item.path);
		const index = todos.findIndex((todo) => todo.id === item.id);
		const result = change(item);
		if (result === undefined) return undefined;
		if (result === null) todos.splice(index, 1);
		else {
			if (result.ownerSessionId !== item.ownerSessionId || result.id !== item.id) throw new Error("Cannot move a Todo between session files.");
			todos[index] = { ...result, path: item.path, revision: item.revision + 1 };
		}
		saveSession(item.path, todos, item.ownerSessionId);
		return result === null ? item : todos[index];
	});
}

export function writeWorkItem(item) {
	if (item.kind !== "todo") throw new Error("Ideas live in Work; local Idea writes are disabled.");
	const cwd = dirname(dirname(dirname(item.path)));
	return mutateTodo(cwd, item.id, (current) => {
		if (current.revision !== item.revision) throw new Error("Todo changed concurrently; re-read it before writing.");
		return item;
	});
}

export function updateWorkItem(cwd, id, changes) {
	return mutateTodo(cwd, id, (item) => ({
		...item,
		title: changes.title === undefined ? item.title : changes.title,
		intent: changes.intent === undefined ? item.intent : changes.intent,
		progress: changes.progress === undefined ? item.progress : changes.progress,
		checklist: changes.checklist === undefined ? item.checklist : normalizeChecklist(changes.checklist),
		updatedAt: new Date().toISOString(),
	}));
}

export function deleteWorkItem(cwd, id, expectedRevision) {
	return mutateTodo(cwd, id, (current) => {
		if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error("Todo changed concurrently; retained instead of deleted.");
		return null;
	});
}

export function setTodoStatus(cwd, id, status) {
	return mutateTodo(cwd, id, (item) => ({ ...item, status: normalizeTodoStatus(status), updatedAt: new Date().toISOString() }));
}

export function startTodo(cwd, id) { return setTodoStatus(cwd, id, "in_progress"); }
export function completeTodo(cwd, id) { return setTodoStatus(cwd, id, "done"); }
export function reopenTodo(cwd, id) { return setTodoStatus(cwd, id, "ready"); }

export function cycleTodo(item) {
	if (!item || item.kind !== "todo") return undefined;
	const cwd = dirname(dirname(dirname(item.path)));
	return mutateTodo(cwd, item.id, (current) => ({
		...current,
		status: current.status === "ready" ? "in_progress" : current.status === "in_progress" ? "done" : "ready",
		updatedAt: new Date().toISOString(),
	}));
}

export function clearCompleted(cwd, options = {}) {
	const deleted = [];
	for (const item of listTodos(cwd, options).filter(isCompleted)) {
		const removed = mutateTodo(cwd, item.id, (current) => isCompleted(current) ? null : undefined);
		if (removed) deleted.push(removed);
	}
	return deleted;
}

function parseMarkdownRecord(path) {
	try {
		const text = readFileSync(path, "utf8");
		const headerEnd = text.search(/\r?\n\r?\n/);
		const headerText = headerEnd === -1 ? text : text.slice(0, headerEnd);
		const body = headerEnd === -1 ? "" : text.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
		return { metadata: Parse(LegacyMetadataSchema, JSON.parse(headerText)), body };
	} catch {
		return undefined;
	}
}

function markdownBodyFields(body, status, kind) {
	const checklist = [];
	const prose = [];
	for (const rawLine of String(body ?? "").split(/\r?\n/)) {
		const match = rawLine.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
		if (match) checklist.push({ text: match[2].trim(), done: match[1].toLowerCase() === "x" });
		else prose.push(rawLine.replace(/^\s*#{1,6}\s+/, "").trimEnd());
	}
	const text = prose.join("\n").trim();
	return {
		intent: kind === "idea" || status !== "done" ? text : "",
		progress: kind === "todo" && status === "done" ? text : "",
		checklist,
	};
}

function legacySessionId(metadata) {
	const tag = metadata.tags?.find((value) => value.startsWith("session:"));
	return tag?.slice("session:".length);
}

function importLegacy(cwd, candidate, sourcePath) {
	return withStoreLock(cwd, () => {
		if (!existsSync(sourcePath)) return undefined; // Another process already migrated it.
		const id = normalizeWorkItemId(candidate.id);
		const existing = getWorkItem(cwd, id);
		if (existing) {
			const comparable = { ...candidate, id, createdAt: candidate.createdAt || existing.createdAt, updatedAt: candidate.updatedAt || existing.updatedAt };
			if (existing.kind !== "todo" || JSON.stringify(encodeItem(existing)) !== JSON.stringify(encodeItem(comparable))) throw new Error(`Conflicting Todo migration for ${id}; original retained: ${sourcePath}`);
			unlinkSync(sourcePath);
			return { item: existing, sourcePath };
		}
		const item = createUnlocked(cwd, { ...candidate, id });
		unlinkSync(sourcePath);
		return { item, sourcePath };
	});
}

function migrateMarkdownDirectory(cwd, directory, sourceKind) {
	const migrated = [];
	if (!existsSync(directory)) return migrated;
	for (const name of readdirSync(directory).filter((value) => value.endsWith(".md"))) {
		const sourcePath = join(directory, name);
		const parsed = parseMarkdownRecord(sourcePath);
		if (!parsed) continue;
		const metadata = parsed.metadata;
		const declaredKind = metadata.kind === "idea" ? "idea" : sourceKind;
		const ownerSessionId = declaredKind === "todo" ? (metadata.owner_session_id ?? legacySessionId(metadata)) : undefined;
		const rawStatus = normalizeTodoStatus(metadata.status);
		const status = rawStatus === "ready" && metadata.assigned_to_session ? "in_progress" : rawStatus;
		const kind = declaredKind === "idea" || (!ownerSessionId && status !== "done") ? "idea" : "todo";
		if (kind === "idea") continue; // Preserve unmigrated Ideas for the explicit Work importer.
		const bodyFields = markdownBodyFields(parsed.body, status, kind);
		migrated.push(importLegacy(cwd, {
			id: metadata.id ?? basename(name, ".md"),
			kind,
			title: String(metadata.title ?? "Untitled"),
			...bodyFields,
			status: kind === "todo" ? status : undefined,
			ownerSessionId: kind === "todo" ? ownerSessionId : undefined,
			createdInSessionId: metadata.created_in_session_id ?? metadata.origin_session_id ?? ownerSessionId ?? metadata.assigned_to_session,
			createdAt: String(metadata.created_at ?? ""),
			updatedAt: String(metadata.updated_at ?? metadata.created_at ?? ""),
		}, sourcePath));
	}
	return migrated.filter(Boolean);
}

export function migrateLegacyWorkItems(cwd) {
	const json = legacyItems(cwd).some((item) => item.kind === "todo") ? withStoreLock(cwd, () => migrateJsonUnlocked(cwd)) : [];
	return [
		...json,
		...migrateMarkdownDirectory(cwd, workItemsDirectory(cwd), "todo"),
		...migrateMarkdownDirectory(cwd, join(cwd, ".pi", "todos"), "todo"),
	];
}
