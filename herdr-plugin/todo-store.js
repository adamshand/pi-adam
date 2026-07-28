import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const SESSION_TAG_PREFIX = "session:";

export function sessionTag(sessionId) {
	return `${SESSION_TAG_PREFIX}${sessionId}`;
}

export function todosDirectory(cwd) {
	return join(cwd, ".pi", "todos");
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
	const tags = Array.isArray(metadata.tags) ? metadata.tags.map(String) : [];
	metadata.tags = tags;
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

export function listTodos(cwd, options = {}) {
	const scope = options.scope ?? "project";
	const wantedSessionTag = options.sessionId ? sessionTag(options.sessionId) : undefined;
	let names = [];
	try {
		const directory = todosDirectory(cwd);
		if (!existsSync(directory)) return [];
		names = readdirSync(directory).filter((name) => name.endsWith(".md"));
	} catch {
		return [];
	}

	return names
		.map((name) => readTodo(join(todosDirectory(cwd), name)))
		.filter(Boolean)
		.filter((todo) => scope === "project" || (wantedSessionTag !== undefined && todo.tags.includes(wantedSessionTag)))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
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
