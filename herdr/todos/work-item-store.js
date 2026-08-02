import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const SCHEMA_VERSION = 1;
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
		if (!item || typeof item !== "object") return [];
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
	return join(cwd, ".pi", "work-items");
}

export function workItemPath(cwd, id) {
	return join(workItemsDirectory(cwd), `${normalizeWorkItemId(id)}.json`);
}

export function readWorkItem(path) {
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		const kind = data.kind === "idea" ? "idea" : "todo";
		return {
			path,
			id: String(data.id ?? basename(path, ".json")),
			kind,
			title: String(data.title ?? "Untitled"),
			intent: typeof data.intent === "string" ? data.intent : "",
			progress: typeof data.progress === "string" ? data.progress : "",
			checklist: normalizeChecklist(data.checklist),
			status: kind === "todo" ? normalizeTodoStatus(data.status) : undefined,
			ownerSessionId: kind === "todo" && typeof data.owner_session_id === "string" ? data.owner_session_id : undefined,
			createdInSessionId: typeof data.created_in_session_id === "string" ? data.created_in_session_id : undefined,
			createdAt: String(data.created_at ?? ""),
			updatedAt: String(data.updated_at ?? data.created_at ?? ""),
		};
	} catch {
		return undefined;
	}
}

export function writeWorkItem(item) {
	const kind = item.kind === "idea" ? "idea" : "todo";
	const createdAt = item.createdAt || new Date().toISOString();
	const data = {
		schema_version: SCHEMA_VERSION,
		id: normalizeWorkItemId(item.id),
		kind,
		title: String(item.title ?? "Untitled"),
		...(item.intent ? { intent: String(item.intent) } : {}),
		...(item.progress ? { progress: String(item.progress) } : {}),
		...(normalizeChecklist(item.checklist).length > 0 ? { checklist: normalizeChecklist(item.checklist) } : {}),
		...(kind === "todo" ? { status: normalizeTodoStatus(item.status) } : {}),
		...(kind === "todo" && item.ownerSessionId ? { owner_session_id: item.ownerSessionId } : {}),
		...(item.createdInSessionId ? { created_in_session_id: item.createdInSessionId } : {}),
		created_at: createdAt,
		updated_at: item.updatedAt || createdAt,
	};
	mkdirSync(dirname(item.path), { recursive: true });
	const temporary = `${item.path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	try {
		renameSync(temporary, item.path);
	} catch (error) {
		try { unlinkSync(temporary); } catch {}
		throw error;
	}
	return readWorkItem(item.path);
}

function nextId(cwd) {
	let id;
	do id = randomBytes(4).toString("hex");
	while (existsSync(workItemPath(cwd, id)));
	return id;
}

export function createWorkItem(cwd, options) {
	mkdirSync(workItemsDirectory(cwd), { recursive: true });
	const now = new Date().toISOString();
	const requestedId = normalizeWorkItemId(options.id);
	const id = requestedId && !existsSync(workItemPath(cwd, requestedId)) ? requestedId : nextId(cwd);
	return writeWorkItem({
		path: workItemPath(cwd, id),
		id,
		kind: options.kind,
		title: options.title,
		intent: options.intent ?? "",
		progress: options.progress ?? "",
		checklist: options.checklist ?? [],
		status: options.status,
		ownerSessionId: options.ownerSessionId,
		createdInSessionId: options.createdInSessionId,
		createdAt: options.createdAt || now,
		updatedAt: options.updatedAt || options.createdAt || now,
	});
}

export function createTodo(cwd, options) {
	return createWorkItem(cwd, { ...options, kind: "todo" });
}

export function createIdea(cwd, options) {
	return createWorkItem(cwd, { ...options, kind: "idea" });
}

export function listWorkItems(cwd) {
	let names;
	try {
		if (!existsSync(workItemsDirectory(cwd))) return [];
		names = readdirSync(workItemsDirectory(cwd)).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return names
		.map((name) => readWorkItem(join(workItemsDirectory(cwd), name)))
		.filter(Boolean)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function listTodos(cwd, options = {}) {
	return listWorkItems(cwd).filter((item) => item.kind === "todo" && (options.sessionId === undefined || item.ownerSessionId === options.sessionId));
}

export function listIdeas(cwd) {
	return listWorkItems(cwd).filter((item) => item.kind === "idea");
}

export function getWorkItem(cwd, id) {
	return readWorkItem(workItemPath(cwd, id));
}

export function updateWorkItem(cwd, id, changes) {
	const item = getWorkItem(cwd, id);
	if (!item) return undefined;
	return writeWorkItem({
		...item,
		title: changes.title === undefined ? item.title : changes.title,
		intent: changes.intent === undefined ? item.intent : changes.intent,
		progress: changes.progress === undefined ? item.progress : changes.progress,
		checklist: changes.checklist === undefined ? item.checklist : changes.checklist,
		updatedAt: new Date().toISOString(),
	});
}

export function deleteWorkItem(cwd, id) {
	const item = getWorkItem(cwd, id);
	if (!item) return undefined;
	try {
		unlinkSync(item.path);
		return item;
	} catch {
		return undefined;
	}
}

export function setTodoStatus(cwd, id, status) {
	const item = getWorkItem(cwd, id);
	if (!item || item.kind !== "todo") return undefined;
	return writeWorkItem({ ...item, status: normalizeTodoStatus(status), updatedAt: new Date().toISOString() });
}

export function startTodo(cwd, id) {
	return setTodoStatus(cwd, id, "in_progress");
}

export function completeTodo(cwd, id) {
	return setTodoStatus(cwd, id, "done");
}

export function reopenTodo(cwd, id) {
	return setTodoStatus(cwd, id, "ready");
}

export function cycleTodo(item) {
	if (!item || item.kind !== "todo") return undefined;
	const next = item.status === "ready" ? "in_progress" : item.status === "in_progress" ? "done" : "ready";
	return writeWorkItem({ ...item, status: next, updatedAt: new Date().toISOString() });
}

export function promoteIdea(cwd, id, ownerSessionId) {
	const item = getWorkItem(cwd, id);
	if (!item || item.kind !== "idea") return undefined;
	const todo = writeWorkItem({ ...item, kind: "todo", status: "ready", ownerSessionId, updatedAt: new Date().toISOString() });
	return { idea: item, todo };
}

export function deferTodo(cwd, id, ownerSessionId) {
	const item = getWorkItem(cwd, id);
	if (!item || item.kind !== "todo" || isCompleted(item) || (ownerSessionId && item.ownerSessionId !== ownerSessionId)) return undefined;
	const idea = writeWorkItem({ ...item, kind: "idea", status: undefined, ownerSessionId: undefined, updatedAt: new Date().toISOString() });
	return { todo: item, idea };
}

export function toggleWorkItemKind(cwd, id, ownerSessionId) {
	const item = getWorkItem(cwd, id);
	if (!item) return undefined;
	if (item.kind === "idea") return writeWorkItem({ ...item, kind: "todo", status: "ready", ownerSessionId, updatedAt: new Date().toISOString() });
	return writeWorkItem({ ...item, kind: "idea", status: undefined, ownerSessionId: undefined, updatedAt: new Date().toISOString() });
}

export function deleteIdea(cwd, id) {
	const item = getWorkItem(cwd, id);
	return item?.kind === "idea" ? deleteWorkItem(cwd, id) : undefined;
}

export function clearCompleted(cwd, options = {}) {
	const deleted = [];
	for (const item of listTodos(cwd, options).filter(isCompleted)) {
		const removed = deleteWorkItem(cwd, item.id);
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
		return { metadata: JSON.parse(headerText), body };
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
	const tag = Array.isArray(metadata.tags) ? metadata.tags.find((value) => typeof value === "string" && value.startsWith("session:")) : undefined;
	return tag?.slice("session:".length);
}

function sameWorkItem(existing, candidate) {
	return existing.kind === candidate.kind && existing.title === candidate.title;
}

function importLegacy(cwd, candidate, sourcePath) {
	let id = normalizeWorkItemId(candidate.id);
	const existing = getWorkItem(cwd, id);
	if (existing && sameWorkItem(existing, candidate)) {
		try { unlinkSync(sourcePath); } catch {}
		return { item: existing, sourcePath };
	}
	if (existing) id = nextId(cwd);
	const item = createWorkItem(cwd, { ...candidate, id });
	try { unlinkSync(sourcePath); } catch {}
	return { item, sourcePath };
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
	return migrated;
}

export function migrateLegacyWorkItems(cwd) {
	return [
		...migrateMarkdownDirectory(cwd, workItemsDirectory(cwd), "todo"),
		...migrateMarkdownDirectory(cwd, join(cwd, ".pi", "todos"), "todo"),
		...migrateMarkdownDirectory(cwd, join(cwd, ".pi", "ideas"), "idea"),
	];
}
