import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WorkClient } from "./work-client.js";
import { workFixture } from "./work-test-fixture.js";

test("blocked captures are visible and explicitly retryable without storing credentials", async () => {
	const f = await workFixture();
	try {
		f.control.fail = 401;
		const capture = await f.client.create(f.cwd, { title: "Retry credentials" });
		assert.equal(capture.blocked, true);
		f.control.fail = 0;
		const list = await f.client.list(f.cwd);
		assert.equal(list.outbox.blocked, 1);
		await f.client.flush(true);
		assert.equal(f.items.size, 1);
		assert.equal((await f.client.list(f.cwd)).outbox.pending, 0);
		for (const name of await readdir(f.options.stateDir)) {
			assert.ok(!(await readFile(join(f.options.stateDir, name), "utf8")).includes("test-token"));
		}
	} finally { await f.close(); }
});

test("ambiguous short IDs reject and cache never leaks a previous project after config changes", async () => {
	const f = await workFixture();
	try {
		const { item } = await f.client.create(f.cwd, { title: "First" });
		const duplicate = { ...item, id: "work_ffffffffffffffffff000001" };
		f.items.set(duplicate.id, duplicate);
		await assert.rejects(f.client.resolve(f.cwd, "IDEA-000001"), /Ambiguous/);
		assert.equal((await f.client.resolve(f.cwd, duplicate.id)).id, duplicate.id);
		await f.client.list(f.cwd);
		await writeFile(join(f.cwd, ".pi/work.json"), JSON.stringify({ project: "different" }));
		f.control.fail = 503;
		const result = await f.client.list(f.cwd);
		assert.equal(result.stale, true);
		assert.deepEqual(result.items, []);
	} finally { await f.close(); }
});

test("auth overrides and repository aliases work without creating .pi files", async () => {
	const f = await workFixture();
	try {
		const cwd = join(f.directory, "made.git");
		await mkdir(cwd);
		const client = new WorkClient({ ...f.options, env: { WORK_API_TOKEN: "test-token", HAUME_WORK_API_TOKEN: "wrong-token" } });
		const { item } = await client.create(cwd, { title: "Alias capture" });
		assert.equal(item.project.slug, "haume-made");
		assert.deepEqual(await readdir(cwd), []);
	} finally { await f.close(); }
});

test("capture UUID reuse rejects changed content both while queued and after delivery", async () => {
 const f = await workFixture();
 try {
  f.control.fail = 503;
  const capture = await f.client.create(f.cwd, { title: "Original" });
  await assert.rejects(f.client.create(f.cwd, { title: "Edited" }, capture.key), /content changed/);
  f.control.fail = 0;
  await f.client.flush();
  await assert.rejects(f.client.create(f.cwd, { title: "Edited" }, capture.key), /content changed/);
  assert.equal(f.items.size, 1);
  assert.equal([...f.items.values()][0].title, "Original");
 } finally { await f.close(); }
});
