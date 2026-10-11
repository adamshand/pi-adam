import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WorkClient } from "./work-client.js";

import { workFixture } from "./work-test-fixture.js";
test("Work captures use structured descriptions, source and project, and persist no local Ideas", async () => {
	const f = await workFixture();
	try {
		const result = await f.client.create(f.cwd, { title: "Capture", intent: "Why", checklist: [{ text: "Group", items: [{ text: "Check", done: true }] }], source: "idea" });
		assert.equal(result.queued, false);
		assert.equal(result.item.source, "idea");
		assert.match(result.item.description, /Why\n\n- \[ \] Group\n  - \[x\] Check/);
		assert.equal(result.item.project.slug, "project");
		await assert.rejects(readFile(join(f.cwd, ".pi/work-items")));
		assert.equal((await f.client.list(f.cwd)).items.length, 1);
		const id = result.item.id;
		assert.equal((await f.client.resolve(f.cwd, `IDEA-${id.slice(-6)}`)).id, id);
	} finally { await f.close(); }
});

test("lost create response replays the durable UUID/payload after a new client starts", async () => {
	const f = await workFixture();
	try {
		f.control.loseCreateResponse = true;
		const result = await f.client.create(f.cwd, { title: "Capture once" });
		assert.equal(result.queued, true);
		assert.equal(f.items.size, 1);
		const entry = JSON.parse((await readFile(join(f.options.stateDir, "work-outbox.jsonl"), "utf8")).trim());
		assert.equal(entry.key, result.key);
		assert.equal(entry.payload.project, "project");
		const second = new WorkClient(f.options);
		await second.list(f.cwd);
		assert.equal(f.items.size, 1);
		assert.equal(await readFile(join(f.options.stateDir, "work-outbox.jsonl"), "utf8"), "");
		const posts = f.calls.filter((call) => call.method === "POST");
		assert.equal(posts.length, 2);
		assert.equal(posts[0].key, posts[1].key);
		assert.deepEqual(posts[0].body, posts[1].body);
	} finally { await f.close(); }
});

test("offline captures queue, transient failures replay, invalid/auth failures remain visibly blocked", async () => {
	const f = await workFixture();
	try {
		f.control.fail = 503;
		const queued = await f.client.create(f.cwd, { title: "Later" });
		assert.equal(queued.queued, true);
		assert.equal(queued.blocked, false);
		f.control.fail = 0;
		await f.client.list(f.cwd);
		assert.equal(f.items.size, 1);
		f.control.fail = 401;
		const blocked = await f.client.create(f.cwd, { title: "Credentials" });
		assert.equal(blocked.blocked, true);
		f.control.fail = 0;
		await f.client.list(f.cwd);
		assert.equal(f.items.size, 1);
		await assert.rejects(f.client.create(f.cwd, { title: " " }), /title/);
	} finally { await f.close(); }
});

test("lists filter every source to the project, cache stale results and isolate unassigned items", async () => {
	const f = await workFixture();
	try {
		const { item } = await f.client.create(f.cwd, { title: "Here" });
		item.source = "feedback";
		f.items.set(item.id, item);
		f.items.set("work_ffffffffffffffffffffffff", { ...item, id: "work_ffffffffffffffffffffffff", title: "Elsewhere", project: { slug: "elsewhere" } });
		assert.equal((await f.client.list(f.cwd)).items.length, 1);
		f.control.fail = 503;
		const cached = await f.client.list(f.cwd);
		assert.equal(cached.stale, true);
		assert.equal(cached.items[0].id, item.id);
		await assert.rejects(f.client.resolve(f.cwd, "IDEA-000001"), /stale/);
		f.control.fail = 0;
		await writeFile(join(f.cwd, ".pi/work.json"), JSON.stringify({ project: null }));
		assert.deepEqual((await f.client.list(f.cwd)).items, []);
		await assert.rejects(f.client.resolve(f.cwd, item.id), /another Project/);
	} finally { await f.close(); }
});

test("409 retries re-read revisions and reapply against current Markdown, with a bounded retry count", async () => {
	const f = await workFixture();
	try {
		const { item } = await f.client.create(f.cwd, { title: "Edit", intent: "Original" });
		f.control.conflicts = 1;
		const updated = await f.client.patchWith(item.id, (current) => ({ description: current.description + "\nOur edit" }));
		assert.equal(updated.description, "Original\nConcurrent edit\nOur edit");
		assert.equal(updated.revision, 3);
		f.control.conflicts = 10;
		await assert.rejects(f.client.patch(item.id, { state: "open" }), /409/);
		assert.equal(f.control.conflicts, 7);
	} finally { await f.close(); }
});

test("concurrent clients retain every outbox entry and timeouts return stale lists", async () => {
	const f = await workFixture();
	try {
		f.control.fail = 503;
		const other = new WorkClient(f.options);
		await Promise.all([f.client.create(f.cwd, { title: "A" }, randomUUID()), other.create(f.cwd, { title: "B" }, randomUUID())]);
		assert.equal((await readFile(join(f.options.stateDir, "work-outbox.jsonl"), "utf8")).trim().split("\n").length, 2);
		f.control.fail = 0;
		await other.flush();
		assert.equal(f.items.size, 2);
		f.control.delay = 100;
		const impatient = new WorkClient({ ...f.options, timeout: 15 });
		assert.equal((await impatient.list(f.cwd)).stale, true);
	} finally { await f.close(); }
});
