import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createTodo, sessionTag } from "./todo-store.js";

export function ideasDirectory(cwd) {
	return join(cwd, ".pi", "ideas");
}

export function readIdea(path) {
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
			createdAt: String(metadata.created_at ?? ""),
			updatedAt: String(metadata.updated_at ?? metadata.created_at ?? ""),
			metadata,
			body,
		};
	} catch {
		return undefined;
	}
}

export function writeIdea(idea) {
	const content = `${JSON.stringify(idea.metadata, null, 2)}\n\n${idea.body ?? ""}`;
	const temporary = `${idea.path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, content, "utf8");
	try {
		renameSync(temporary, idea.path);
	} catch (error) {
		try { unlinkSync(temporary); } catch {}
		throw error;
	}
}

export function createIdea(cwd, options) {
	const directory = ideasDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	let id;
	let path;
	do {
		id = randomBytes(4).toString("hex");
		path = join(directory, `${id}.md`);
	} while (existsSync(path));
	const createdAt = new Date().toISOString();
	const metadata = { id, title: options.title, created_at: createdAt, updated_at: createdAt };
	writeIdea({ path, metadata, body: options.body ?? "" });
	return readIdea(path);
}

export function updateIdea(cwd, id, changes) {
	const path = join(ideasDirectory(cwd), `${id}.md`);
	const idea = readIdea(path);
	if (!idea) return undefined;
	const title = changes.title?.trim();
	const metadata = {
		...idea.metadata,
		...(title ? { title } : {}),
		updated_at: new Date().toISOString(),
	};
	writeIdea({ ...idea, metadata, body: changes.body === undefined ? idea.body : changes.body });
	return readIdea(path);
}

export function deleteIdea(cwd, id) {
	const path = join(ideasDirectory(cwd), `${id}.md`);
	const idea = readIdea(path);
	if (!idea) return undefined;
	try {
		unlinkSync(path);
		return idea;
	} catch {
		return undefined;
	}
}

export function promoteIdea(cwd, id, sessionId) {
	const idea = readIdea(join(ideasDirectory(cwd), `${id}.md`));
	if (!idea) return undefined;
	const todo = createTodo(cwd, {
		title: idea.title,
		body: idea.body,
		tags: [sessionTag(sessionId)],
	});
	try {
		unlinkSync(idea.path);
		return { idea, todo };
	} catch {
		try { unlinkSync(todo.path); } catch {}
		return undefined;
	}
}

export function listIdeas(cwd) {
	const directory = ideasDirectory(cwd);
	let names;
	try {
		if (!existsSync(directory)) return [];
		names = readdirSync(directory).filter((name) => name.endsWith(".md"));
	} catch {
		return [];
	}
	return names
		.map((name) => readIdea(join(directory, name)))
		.filter(Boolean)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
