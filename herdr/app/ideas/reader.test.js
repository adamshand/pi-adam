import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WorkClient } from "../../todos/work-client.js";
import { workFixture } from "../../todos/work-test-fixture.js";
import { readIdeas } from "./read-ideas.js";

const exec = promisify(execFile);

test("read-only refresh never delivers queued captures or changes Work", async () => {
  const f = await workFixture();
  try {
    f.control.fail = 503;
    await f.client.create(f.cwd, { title: "Keep queued" });
    const outbox = join(f.options.stateDir, "work-outbox.jsonl");
    const before = await readFile(outbox, "utf8");
    f.calls.length = 0; f.control.fail = 0;
    const result = await readIdeas(f.cwd, "refresh", f.client);
    assert.equal(result.version, 1);
    assert.equal(result.cwd, f.cwd);
    assert.equal(result.stale, false);
    assert.equal(result.scopeResolved, true);
    assert.equal(result.project, "project");
    assert.equal(result.outbox.pending, 1);
    assert.equal(f.items.size, 0);
    assert.ok(f.calls.length > 0);
    assert.ok(f.calls.every(call => call.method === "GET"));
    assert.equal(await readFile(outbox, "utf8"), before);
  } finally { await f.close(); }
});

test("cached reads use no network/credentials and retain the exact project scope", async () => {
  const f = await workFixture();
  try {
    const created = await f.client.create(f.cwd, { title: "Cached idea" });
    await f.client.listReadOnly(f.cwd);
    f.calls.length = 0;
    const client = new WorkClient({ ...f.options, tokenProvider: () => { throw new Error("Credentials must not be accessed"); } });
    const cached = await readIdeas(f.cwd, "cached", client);
    assert.equal(cached.stale, true);
    assert.equal(cached.items[0].id, created.item.id);
    assert.equal(f.calls.length, 0);
    await writeFile(join(f.cwd, ".pi/work.json"), JSON.stringify({ project: "another" }));
    const other = await client.cachedList(f.cwd);
    assert.deepEqual(other.items, []);
    assert.equal(other.project, "another");
    assert.equal(other.scopeResolved, true);
  } finally { await f.close(); }
});

test("offline refresh retains cached items, while a cold offline project remains explicit", async () => {
  const f = await workFixture();
  try {
    const created = await f.client.create(f.cwd, { title: "Offline readable" });
    await f.client.listReadOnly(f.cwd);
    f.control.fail = 503;
    const cached = await f.client.listReadOnly(f.cwd);
    assert.equal(cached.items[0].id, created.item.id);
    assert.equal(cached.stale, true);
    assert.equal(cached.project, "project");
    await writeFile(join(f.cwd, ".pi/work.json"), JSON.stringify({ project: "cold-project" }));
    const cold = await f.client.listReadOnly(f.cwd);
    assert.equal(cold.scopeResolved, true);
    assert.equal(cold.project, "cold-project");
    assert.equal(cold.fetchedAt, null);
    assert.deepEqual(cold.items, []);
    await rm(join(f.cwd, ".pi/work.json"));
    const unresolved = await f.client.cachedList(f.cwd);
    assert.equal(unresolved.scopeResolved, false);
    assert.deepEqual(unresolved.items, []);
  } finally { await f.close(); }
});

test("unassigned Ideas never include another project's items", async () => {
  const f = await workFixture();
  try {
    await f.client.create(f.cwd, { title: "Project idea" });
    await writeFile(join(f.cwd, ".pi/work.json"), JSON.stringify({ project: null }));
    const unassigned = await f.client.create(f.cwd, { title: "Unassigned idea" });
    f.calls.length = 0;
    const result = await readIdeas(f.cwd, "refresh", f.client);
    assert.equal(result.project, null);
    assert.equal(result.scopeResolved, true);
    assert.deepEqual(result.items.map(item => item.id), [unassigned.item.id]);
    assert.ok(f.calls.every(call => call.method === "GET"));
  } finally { await f.close(); }
});

test("CLI emits a sanitized envelope and cached mode performs no HTTP", async () => {
  const f = await workFixture();
  try {
    const script = fileURLToPath(new URL("./read-ideas.js", import.meta.url));
    const env = { ...process.env, WORK_URL: f.options.url, WORK_API_TOKEN: "test-token", XDG_STATE_HOME: join(f.directory, "cli-state") };
    const result = await exec(process.execPath, [script, f.cwd, "refresh"], { env });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.stale, false);
    assert.equal(parsed.project, "project");
    assert.ok(!result.stdout.includes("test-token"));
    f.calls.length = 0;
    const cached = await exec(process.execPath, [script, f.cwd, "cached"], { env: { ...env, WORK_API_TOKEN: "no-credentials" } });
    assert.equal(JSON.parse(cached.stdout).stale, true);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
