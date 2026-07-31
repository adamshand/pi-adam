import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const SESSION_TAG_PREFIX = "session:";

export function normalizeTodoId(value) {
	let id = String(value ?? "").trim();
	if (id.startsWith("#")) id = id.slice(1);
	if (id.toUpperCase().startsWith("TODO-")) id = id.slice(5);
	return id;
}

export function sessionTag(sessionId) {
	return `${SESSION_TAG_PREFIX}${sessionId}`;
}

export function sessionIdForTodo(todo) {
	const tag = todo.tags.find((value) => value.startsWith(SESSION_TAG_PREFIX));
	return tag?.slice(SESSION_TAG_PREFIX.length);
}

export function isSessionTodo(todo) {
	return sessionIdForTodo(todo) !== undefined;
}

export function todosDirectory(cwd) {
	return join(cwd, ".pi", "todos");
}

export function todoPath(cwd, id) {
	return join(todosDirectory(cwd), `${normalizeTodoId(id)}.md`);
}

export function isCompleted(todo) {
	return todo.status === "closed" || todo.status === "done";
}

export function todoState(todo) {
	if (isCompleted(todo)) return "done";
	if (todo.assignedToSession) return "in_progress";
	return "outstanding";
}

export function readTodo(path) {
	try {
		const text = readFileSync(path, "utf8");
		const headerEnd = text.search(/\r?\n\r?\n/);
		const headerText = headerEnd === -1 ? text : text.slice(0, headerEnd);
		const body = headerEnd === -1 ? "" : text.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
		const metadata = JSON.parse(headerText);
		return {
			path,
			id: String(metadata.id ?? basename(path, ".md")),
			title: String(metadata.title ?? "Untitled"),
			status: String(metadata.status ?? "open"),
			tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
			createdAt: String(metadata.created_at ?? ""),
			assignedToSession: typeof metadata.assigned_to_session === "string" ? metadata.assigned_to_session : undefined,
			metadata,
			body,
		};
	} catch {
		return undefined;
	}
}

export function writeTodo(todo) {
	const metadata = { ...todo.metadata };
	metadata.tags = Array.isArray(metadata.tags) ? metadata.tags.map(String) : [];
	if (metadata.status === "closed" || metadata.status === "done") delete metadata.assigned_to_session;
	const content = `${JSON.stringify(metadata, null, 2)}\n\n${todo.body ?? ""}`;
	const temporary = `${todo.path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, content, "utf8");
	try {
		renameSync(temporary, todo.path);
	} catch (error) {
		try { unlinkSync(temporary); } catch {}
		throw error;
	}
}

export function createTodo(cwd, options) {
	const directory = todosDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	let id;
	let path;
	do {
		id = randomBytes(4).toString("hex");
		path = join(directory, `${id}.md`);
	} while (existsSync(path));
	const metadata = {
		id,
		title: options.title,
		tags: options.tags ?? [],
		status: options.status ?? "open",
		created_at: new Date().toISOString(),
		...(options.assignedToSession ? { assigned_to_session: options.assignedToSession } : {}),
	};
	writeTodo({ path, metadata, body: options.body ?? "" });
	return readTodo(path);
}

export function listTodos(cwd, options = {}) {
	let names = [];
	try {
		const directory = todosDirectory(cwd);
		if (!existsSync(directory)) return [];
		names = readdirSync(directory).filter((name) => name.endsWith(".md"));
	} catch {
		return [];
	}
	const wantedTag = options.sessionId ? sessionTag(options.sessionId) : undefined;
	return names
		.map((name) => readTodo(join(todosDirectory(cwd), name)))
		.filter(Boolean)
		.filter((todo) => wantedTag === undefined || todo.tags.includes(wantedTag))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function getTodo(cwd, id) {
	return readTodo(todoPath(cwd, id));
}

export function updateTodo(cwd, id, changes) {
	const todo = getTodo(cwd, id);
	if (!todo) return undefined;
	const metadata = { ...todo.metadata };
	if (changes.title !== undefined) metadata.title = changes.title;
	if (changes.status !== undefined) metadata.status = changes.status;
	if (changes.tags !== undefined) metadata.tags = changes.tags;
	if (changes.assignedToSession !== undefined) {
		if (changes.assignedToSession) metadata.assigned_to_session = changes.assignedToSession;
		else delete metadata.assigned_to_session;
	}
	writeTodo({ ...todo, metadata, body: changes.body === undefined ? todo.body : changes.body });
	return readTodo(todo.path);
}

export function appendTodo(cwd, id, body) {
	const todo = getTodo(cwd, id);
	if (!todo) return undefined;
	const addition = String(body ?? "").trim();
	if (!addition) return todo;
	const existing = todo.body.replace(/\s+$/, "");
	writeTodo({ ...todo, body: existing ? `${existing}\n\n${addition}\n` : `${addition}\n` });
	return readTodo(todo.path);
}

export function deleteTodo(cwd, id) {
	const todo = getTodo(cwd, id);
	if (!todo) return undefined;
	try {
		unlinkSync(todo.path);
		return todo;
	} catch {
		return undefined;
	}
}

export function claimTodo(cwd, id, sessionId, force = false) {
	const todo = getTodo(cwd, id);
	if (!todo || isCompleted(todo)) return undefined;
	if (todo.assignedToSession && todo.assignedToSession !== sessionId && !force) return { conflict: todo.assignedToSession };
	return updateTodo(cwd, id, { assignedToSession: sessionId });
}

export function releaseTodo(cwd, id, sessionId, force = false) {
	const todo = getTodo(cwd, id);
	if (!todo) return undefined;
	if (todo.assignedToSession && todo.assignedToSession !== sessionId && !force) return { conflict: todo.assignedToSession };
	return updateTodo(cwd, id, { assignedToSession: "" });
}

export function cycleTodo(todo, sessionId) {
	const state = todoState(todo);
	const metadata = { ...todo.metadata };
	if (state === "outstanding") {
		metadata.status = "open";
		if (sessionId) metadata.assigned_to_session = sessionId;
	} else if (state === "in_progress") {
		metadata.status = "closed";
		delete metadata.assigned_to_session;
	} else {
		metadata.status = "open";
		delete metadata.assigned_to_session;
	}
	writeTodo({ ...todo, metadata });
	return readTodo(todo.path);
}

export function clearCompleted(cwd, options = {}) {
	const completed = listTodos(cwd, options).filter(isCompleted);
	const deleted = [];
	for (const todo of completed) {
		try {
			unlinkSync(todo.path);
			deleted.push(todo);
		} catch {
			// Another process may have removed it after the list was read.
		}
	}
	return deleted;
}
