import assert from "node:assert/strict";
import test from "node:test";
import { IdeasFeed, resolveIdeasContext, parseIdeas } from "./ideas-model.js";
import { LABEL, sessionPath } from "./model.js";

const config = { ideas_reader: "/repo/read-ideas.js", node: "/usr/bin/node" };
const context = (cwd = "/project") => resolveIdeasContext({ terminal: "t1", cwd }, [], [], config);
const item = (id = "a", project = "project") => ({ id: `work_${id.repeat(24)}`, title: "Consider this", description: "Why it matters", state: "inbox", source: "feedback", project: project ? { slug: project } : null, updated_at: "2026-10-30T10:00:00Z" });
const envelope = (cwd = "/project", items = [item()], stale = false) => ({ version: 1, cwd, items, project: "project", scopeResolved: true, stale, fetchedAt: "2026-10-30T10:00:00Z", url: "https://mahi.haume.nz" });
const encoded = (...args) => JSON.stringify(envelope(...args));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("Ideas follow the focused folder without requiring a Pi session", () => {
  const local = context();
  assert.equal(local.cwd, "/project");
  assert.equal(local.reader, config.ideas_reader);
  assert.equal(local.message, "");
  assert.notEqual(context("/other").key, local.key);
  assert.equal(resolveIdeasContext(null, [], [], config).reader, config.ideas_reader);
  assert.match(resolveIdeasContext(null, [], [], config).message, /Focus/);
});

test("Pi uses its stable project folder, and remote paths never fall back locally", () => {
  const session = { version: 1, owner: "owner", session_id: "s", cwd: "/project", todo_path: sessionPath("/project", "s"), ideas_reader: "/remote/read-ideas.js", node: "/remote/node" };
  const all = [{ address: "vps/t1", state: "live", labels: { [LABEL]: JSON.stringify(session) } }];
  const remote = resolveIdeasContext({ terminal: "vps/t1", cwd: "/shell-cwd" }, all, [], config);
  assert.equal(remote.cwd, "/project");
  assert.equal(remote.on, "vps");
  assert.equal(remote.reader, "/remote/read-ideas.js");
  const unbound = resolveIdeasContext({ terminal: "vps/t2", cwd: "/project" }, all, [], config);
  assert.equal(unbound.reader, null);
  assert.match(unbound.message, /Reload/);
});

test("Ideas snapshots reject other projects, wrong roots, duplicates and unsafe links", () => {
  assert.equal(parseIdeas(encoded(), context()).items[0].source, "feedback");
  const invalid = [
    envelope("/other"), envelope("/project", [item("a", "elsewhere")]),
    envelope("/project", [item(), item()]),
    { ...envelope(), url: "https://secret@example.test" },
    { ...envelope(), url: "https://example.test/path" },
    { ...envelope(), url: "http://external.test" },
    { ...envelope(), scopeResolved: false },
    { ...envelope(), items: [{ ...item(), state: "done" }] }
  ];
  for (const data of invalid) assert.throws(() => parseIdeas(JSON.stringify(data), context()));
  const unassigned = { ...envelope(), project: null, items: [item("b", null)] };
  assert.equal(parseIdeas(JSON.stringify(unassigned), context()).project, null);
});

test("cached Ideas appear before a slow online request finishes", async () => {
  const online = deferred(), seen = [];
  const feed = new IdeasFeed(async (_context, mode) => mode === "cached" ? encoded("/project", [item()], true) : online.promise);
  feed.select(context());
  const pending = feed.refresh(() => seen.push(feed.snapshot.items.length));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(feed.snapshot.items.length, 1);
  assert.equal(feed.snapshot.stale, true);
  assert.equal(feed.loading, true);
  online.resolve(encoded("/project", [item(), item("b")]));
  await pending;
  assert.equal(feed.snapshot.items.length, 2);
  assert.equal(feed.snapshot.stale, false);
  assert.ok(seen.includes(1));
});

test("offline errors preserve only this context's cache and clearly mark it stale", async () => {
  const feed = new IdeasFeed(async (_context, mode) => {
    if (mode === "cached") return encoded("/project", [item()], true);
    throw new Error("offline");
  });
  feed.select(context()); await feed.refresh();
  assert.equal(feed.snapshot.items.length, 1);
  assert.equal(feed.snapshot.stale, true);
  assert.match(feed.snapshot.error, /unavailable/);
  feed.select(context("/other"));
  assert.deepEqual(feed.snapshot.items, []);
});

test("late cached/online responses and errors cannot overwrite a newly selected project", async () => {
  for (const reject of [false, true]) {
    const slow = deferred();
    const feed = new IdeasFeed(async (ctx, mode) => {
      if (mode === "cached") return encoded(ctx.cwd, [], true);
      return ctx.cwd === "/project" ? slow.promise : encoded(ctx.cwd, [item("b")]);
    });
    feed.select(context());
    const old = feed.refresh();
    await Promise.resolve(); await Promise.resolve();
    feed.select(context("/other"));
    await feed.refresh();
    if (reject) slow.reject(new Error("old failure")); else slow.resolve(encoded());
    await old;
    assert.equal(feed.context.cwd, "/other");
    assert.equal(feed.snapshot.items[0].id, item("b").id);
    assert.equal(feed.snapshot.error, "");
    assert.equal(feed.loading, false);
  }
});

test("an unbound context launches no reader and corrupt caches do not prevent refresh", async () => {
  const modes = [];
  const feed = new IdeasFeed(async (_ctx, mode) => { modes.push(mode); return mode === "cached" ? "{" : encoded(); });
  feed.select(resolveIdeasContext(null, [], [], config));
  await feed.refresh(); assert.deepEqual(modes, []);
  feed.select(context()); await feed.refresh();
  assert.deepEqual(modes, ["cached", "refresh"]);
  assert.equal(feed.snapshot.stale, false);
});
