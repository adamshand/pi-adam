import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { WorkClient, withWorkLock, workDescription } from "./work-client.js";
import { createTodo, deleteWorkItem, getWorkItem, listTodos, writeWorkItem } from "./work-item-store.js";

const intentStart = "<!-- pi:intent -->";
const intentEnd = "<!-- /pi:intent -->";
const checklistStart = "<!-- pi:checklist -->";
const checklistEnd = "<!-- /pi:checklist -->";
function section(description, start, end, value) {
	const first = description.indexOf(start);
	const last = description.indexOf(end, first + start.length);
	const replacement = `${start}\n${value}\n${end}`;
	if (first >= 0 && last >= 0) return description.slice(0, first) + replacement + description.slice(last + end.length);
	return [description, replacement].filter(Boolean).join("\n\n");
}

/** Shared by Pi tools and Herdr, so neither can silently mutate legacy Ideas. */
export class WorkIdeas {
	constructor(client = new WorkClient()) { this.client = client; }
	assertLinked(todo) {
		if (!todo.workId || todo.workUrl !== this.client.url) throw new Error("Todo's Work link does not match WORK_URL; no remote change made.");
	}
	async update(cwd, id, changes) {
		const item = await this.client.resolve(cwd, id);
		return this.client.patchWith(item.id, (current) => {
			const patch = {};
			if (changes.title !== undefined) patch.title = changes.title;
			let description = current.description;
			if (changes.intent !== undefined) description = section(description, intentStart, intentEnd, changes.intent);
			if (changes.checklist !== undefined) description = section(description, checklistStart, checklistEnd, workDescription("", changes.checklist));
			if (description !== current.description) patch.description = description;
			return patch;
		});
	}
	async drop(cwd, id) {
		const item = await this.client.resolve(cwd, id);
		return this.client.patch(item.id, { state: "dropped", comment: "Dropped from Pi Ideas." });
	}
	async promote(cwd, id, sessionId) {
		const item = await this.client.resolve(cwd, id);
		const hash = createHash("sha256").update(`${cwd}:${sessionId}:${item.id}`).digest("hex");
		return withWorkLock(join(this.client.stateDir, `work-promote-${hash}.lock`), async () => {
			const existing = listTodos(cwd, { sessionId }).find((todo) => todo.workId === item.id && todo.workUrl === this.client.url);
			if (existing) return existing;
			if (!["inbox", "open"].includes(item.state)) throw new Error("Only active Work items can be promoted.");
			const remote = await this.client.patch(item.id, { state: "open", comment: `Promoted into Pi session ${sessionId}` });
			return createTodo(cwd, { title: remote.title, intent: remote.description, ownerSessionId: sessionId, createdInSessionId: sessionId, workId: remote.id, workUrl: this.client.url });
		});
	}
	async complete(todo) {
		this.assertLinked(todo);
		return this.client.patch(todo.workId, { state: "done", comment: `Completed in Pi session ${todo.ownerSessionId}` });
	}
	async defer(cwd, id, sessionId) {
		let todo = getWorkItem(cwd, id);
		if (!todo || todo.kind !== "todo" || todo.ownerSessionId !== sessionId || todo.status === "done") throw new Error("Only this session's unfinished Todos can be deferred.");
		let item;
		if (todo.workId) {
			this.assertLinked(todo);
			item = await this.client.patch(todo.workId, { state: "inbox", comment: `Deferred from Pi session ${sessionId}${todo.progress ? `\n\n${todo.progress}` : ""}` });
		} else {
			const key = todo.workCaptureKey ?? randomUUID();
			todo = writeWorkItem({ ...todo, workCaptureKey: key });
			if (!todo) throw new Error("Todo disappeared before its Work capture was queued.");
			const capture = await this.client.create(cwd, { title: todo.title, intent: [todo.intent, todo.progress].filter(Boolean).join("\n\n"), checklist: todo.checklist, source: "agent" }, key);
			if (capture.queued) return { ...capture, todo };
			item = capture.item;
		}
		// Do not discard concurrent local edits or remove a Todo until Work confirms receipt.
		const current = getWorkItem(cwd, id);
		if (current && JSON.stringify({ ...current, workCaptureKey: undefined }) !== JSON.stringify({ ...todo, workCaptureKey: undefined })) {
			writeWorkItem({ ...current, workId: item.id, workUrl: this.client.url });
			throw new Error("Work saved, but Todo changed concurrently and was retained. Retry defer to finish.");
		}
		if (current) deleteWorkItem(cwd, id, current.revision);
		return { item, queued: false };
	}
}
