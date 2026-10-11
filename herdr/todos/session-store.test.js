import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeTodo, createTodo, deleteWorkItem, getWorkItem, listTodos, migrateLegacyWorkItems, sessionTodoPath, updateWorkItem, writeWorkItem } from "./work-item-store.js";

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-session-todos-"));
	return { cwd, close() { rmSync(cwd, { recursive: true, force: true }); } };
}
function oldFile(cwd, id, extra = {}) {
	const directory = join(cwd, ".pi/work-items");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${id}.json`);
	const data = { schema_version: 1, id, kind: "todo", title: id, status: "ready", owner_session_id: "session-a", created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z", ...extra };
	writeFileSync(path, JSON.stringify(data));
	return path;
}
function worker(code) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(stderr)));
	});
}

test("one readable plan file per session, with independent item operations and no automatic deletion", () => {
	const f = fixture();
	try {
		const first = createTodo(f.cwd, { title: "First", ownerSessionId: "session-a" });
		const second = createTodo(f.cwd, { title: "Second", ownerSessionId: "session-a" });
		createTodo(f.cwd, { title: "Other session", ownerSessionId: "session-b" });
		assert.equal(first.path, second.path);
		assert.deepEqual(readdirSync(join(f.cwd, ".pi/todos")), ["session-a.json", "session-b.json"]);
		assert.equal(existsSync(join(f.cwd, ".pi/work-items")), false);
		updateWorkItem(f.cwd, first.id, { progress: "Halfway" });
		deleteWorkItem(f.cwd, second.id);
		assert.equal(getWorkItem(f.cwd, first.id).progress, "Halfway");
		completeTodo(f.cwd, first.id);
		migrateLegacyWorkItems(f.cwd);
		assert.equal(listTodos(f.cwd, { sessionId: "session-a" }).length, 1);
		deleteWorkItem(f.cwd, first.id);
		const file = JSON.parse(readFileSync(first.path, "utf8"));
		assert.equal(file.session_id, "session-a");
		assert.deepEqual(file.todos, []);
		assert.equal(listTodos(f.cwd).length, 1);
	} finally { f.close(); }
});

test("migration groups existing Todos without losing identity, history or Work links; legacy Ideas stay untouched", () => {
	const f = fixture();
	try {
		const a = oldFile(f.cwd, "a", { intent: "Why", progress: "Next step", checklist: [{ text: "Step", done: true }], created_in_session_id: "origin", work_id: "work_0123456789abcdef01234567", work_url: "https://work.haume.nz", work_capture_key: "queued-key" });
		oldFile(f.cwd, "b", { status: "done" });
		oldFile(f.cwd, "c", { owner_session_id: "session-b" });
		oldFile(f.cwd, "unowned", { owner_session_id: undefined });
		const idea = oldFile(f.cwd, "idea", { kind: "idea" });
		const originalIdea = readFileSync(idea, "utf8");
		assert.equal(migrateLegacyWorkItems(f.cwd).length, 4);
		assert.equal(existsSync(a), false);
		assert.equal(readFileSync(idea, "utf8"), originalIdea);
		assert.deepEqual(listTodos(f.cwd, { sessionId: "session-a" }).map((item) => item.id), ["a", "b"]);
		const restored = getWorkItem(f.cwd, "a");
		assert.equal(restored.intent, "Why");
		assert.equal(restored.progress, "Next step");
		assert.equal(restored.workCaptureKey, "queued-key");
		assert.equal(restored.workId, "work_0123456789abcdef01234567");
		assert.equal(restored.createdInSessionId, "origin");
		assert.equal(restored.createdAt, "2026-10-08T00:00:00Z");
		assert.deepEqual(restored.checklist, [{ text: "Step", done: true }]);
		assert.equal(getWorkItem(f.cwd, "unowned").ownerSessionId, undefined);
		assert.equal(migrateLegacyWorkItems(f.cwd).length, 0);
	} finally { f.close(); }
});

test("interrupted migration is idempotent, and conflicts or malformed destination files never destroy originals", () => {
	const f = fixture();
	try {
		const path = oldFile(f.cwd, "a");
		const original = readFileSync(path, "utf8");
		migrateLegacyWorkItems(f.cwd);
		writeFileSync(path, original); // Simulate crash after saving session, before removing source.
		assert.equal(migrateLegacyWorkItems(f.cwd).length, 1);
		assert.equal(listTodos(f.cwd).length, 1);
		writeFileSync(path, original);
		const session = sessionTodoPath(f.cwd, "session-a");
		const raw = JSON.parse(readFileSync(session, "utf8"));
		raw.todos[0].progress = "Concurrent change";
		writeFileSync(session, JSON.stringify(raw));
		assert.throws(() => migrateLegacyWorkItems(f.cwd), /Conflicting/);
		assert.equal(readFileSync(path, "utf8"), original);
		writeFileSync(session, "{broken");
		assert.throws(() => createTodo(f.cwd, { title: "Cannot overwrite", ownerSessionId: "session-a" }));
		assert.equal(readFileSync(session, "utf8"), "{broken");
		assert.equal(readFileSync(path, "utf8"), original);
	} finally { f.close(); }
});

test("concurrent processes retain every Todo and independent field edit in a shared session file", async () => {
	const f = fixture();
	try {
		const shared = createTodo(f.cwd, { title: "Shared", ownerSessionId: "session" });
		const moduleUrl = new URL("./work-item-store.js", import.meta.url).href;
		await Promise.all([0, 1, 2].map((workerId) => worker(`
			import { createTodo, updateWorkItem } from ${JSON.stringify(moduleUrl)};
			for (let i=0; i<10; i++) createTodo(${JSON.stringify(f.cwd)}, { title: ${JSON.stringify(`worker-${workerId}`)} + i, ownerSessionId: "session" });
			updateWorkItem(${JSON.stringify(f.cwd)}, ${JSON.stringify(shared.id)}, ${JSON.stringify(workerId === 0 ? { title: "New title" } : workerId === 1 ? { progress: "New progress" } : { intent: "New intent" })});
		`)));
		assert.equal(listTodos(f.cwd).length, 31);
		assert.deepEqual(readdirSync(join(f.cwd, ".pi/todos")), ["session.json"]);
		const current = getWorkItem(f.cwd, shared.id);
		assert.equal(current.title, "New title");
		assert.equal(current.progress, "New progress");
		assert.equal(current.intent, "New intent");
		assert.throws(() => writeWorkItem({ ...shared, progress: "Stale snapshot" }), /changed concurrently/);
		assert.throws(() => deleteWorkItem(f.cwd, shared.id, shared.revision), /changed concurrently/);
		assert.equal(getWorkItem(f.cwd, shared.id).progress, "New progress");
	} finally { f.close(); }
});

test("session filenames cannot escape the Todo directory or collide with the unowned bucket", () => {
	const f = fixture();
	try {
		const a = createTodo(f.cwd, { title: "Safe", ownerSessionId: "../../elsewhere" });
		const b = createTodo(f.cwd, { title: "Named", ownerSessionId: "_unowned" });
		const c = createTodo(f.cwd, { title: "Unowned" });
		assert.equal(a.path, join(f.cwd, ".pi/todos/%2E%2E%2F%2E%2E%2Felsewhere.json"));
		assert.notEqual(b.path, c.path);
		assert.equal(listTodos(f.cwd).length, 3);
	} finally { f.close(); }
});
