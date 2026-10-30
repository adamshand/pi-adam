import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, sessionPath, resolveSession, parsePlan, checklistProgress, TodoFeed } from "./model.js";

const ref = (id = "one", cwd = "/repo") => ({ version: 1, owner: `runtime-${id}`, session_id: id, cwd, todo_path: sessionPath(cwd, id), name: `Session ${id}` });
const terminal = (address, session) => ({ address, state: "live", labels: { [LABEL]: JSON.stringify(session) } });
const context = (id = "one", address = "t1") => resolveSession({ terminal: address }, [terminal(address, ref(id))]);
const todo = (id = "first", session = "one") => ({ id, kind: "todo", owner_session_id: session, title: "Do the work", status: "in_progress", checklist: [{ text: "Tests", items: [{ text: "Cases", done: true }, { text: "Races", done: false }] }] });
const plan = (session = "one", todos = [todo("first", session)]) => JSON.stringify({ schema_version: 2, session_id: session, todos });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("focus selects identity, not the latest plan in a shared project", () => {
  const all = [terminal("t1", ref("one")), terminal("t2", ref("two"))];
  assert.equal(resolveSession({ terminal: "t1" }, all).session.session_id, "one");
  assert.equal(resolveSession({ terminal: "t2" }, all).session.session_id, "two");
  assert.equal(resolveSession({ terminal: "t1", shown: "t2" }, all).session.session_id, "two");
  assert.equal(resolveSession({ terminal: null }, all).session, null);
});

test("remote sessions stay on their machine and Windows paths are preserved", () => {
  const session = ref("a_b.c", "C:\\Projects\\Work");
  const result = resolveSession({ terminal: "vps/t1" }, [terminal("vps/t1", session)]);
  assert.equal(result.on, "vps");
  assert.equal(result.session.todo_path, "C:\\Projects\\Work\\.pi\\todos\\a%5Fb%2Ec.json");
  assert.equal(sessionPath("/", "a"), "/.pi/todos/a.json");
});

test("missing, malformed, mismatched and dead terminal references never fall back to another session", () => {
  const other = terminal("t2", ref("two"));
  for (const raw of ["{", JSON.stringify({ ...ref(), todo_path: "/another/file.json" }), JSON.stringify({ ...ref(), version: 2 })]) {
    const current = { address: "t1", state: "live", labels: { [LABEL]: raw } };
    const result = resolveSession({ terminal: "t1" }, [current, other]);
    assert.equal(result.session, null);
    assert.match(result.message, /reload/);
  }
  assert.equal(resolveSession({ terminal: "t1" }, [{ ...terminal("t1", ref()), state: "finished" }, other]).session, null);
  const missing = resolveSession({ terminal: "t1" }, [{ address: "t1", state: "live", program: { key: "pi" }, labels: {} }]);
  assert.match(missing.message, /reload/);
});

test("reads the versioned plan and counts nested checklist leaves", () => {
  const parsed = parsePlan(plan(), "one");
  assert.deepEqual(checklistProgress(parsed.todos[0].checklist), { done: 1, total: 2 });
  assert.equal(parsed.todos[0].status, "in_progress");
  assert.deepEqual(parsePlan(null, "one"), { todos: [], missing: true });
});

test("rejects corrupt plans, duplicate IDs, wrong owners and invalid checklists", () => {
  const invalid = [
    "{", plan("two"), plan("one", [todo(), todo()]),
    plan("one", [todo("x", "two")]),
    plan("one", [{ ...todo(), status: "mystery" }]),
    plan("one", [{ ...todo(), checklist: [{ text: "Wrong", done: "yes" }] }]),
    JSON.stringify({ schema_version: 1, session_id: "one", todos: [] })
  ];
  for (const text of invalid) assert.throws(() => parsePlan(text, "one"));
});

test("late reads cannot replace the newly focused session", async () => {
  const first = deferred(), second = deferred();
  const feed = new TodoFeed(path => path.includes("two.json") ? second.promise : first.promise);
  feed.select(context());
  const oldRead = feed.refresh();
  feed.select(context("two"));
  assert.deepEqual(feed.todos, []);
  const newRead = feed.refresh();
  second.resolve(plan("two"));
  assert.equal(await newRead, true);
  first.resolve(plan());
  assert.equal(await oldRead, false);
  assert.equal(feed.context.session.session_id, "two");
  assert.equal(feed.todos[0].id, "first");
  assert.equal(feed.loading, false);
});

test("late errors do not clear the new session or its loading state", async () => {
  const first = deferred(), second = deferred();
  const feed = new TodoFeed(path => path.includes("two.json") ? second.promise : first.promise);
  feed.select(context());
  const oldRead = feed.refresh();
  feed.select(context("two"));
  const newRead = feed.refresh();
  first.reject(new Error("offline"));
  await oldRead;
  assert.equal(feed.error, "");
  assert.equal(feed.loading, true);
  second.resolve(plan("two"));
  await newRead;
  assert.equal(feed.error, "");
});

test("identical data is quiet; malformed updates clear stale data and recover", async () => {
  let value = plan();
  const feed = new TodoFeed(async () => value);
  feed.select(context());
  assert.equal(await feed.refresh(), true);
  assert.equal(await feed.refresh(), false);
  value = "{";
  assert.equal(await feed.refresh(), true);
  assert.deepEqual(feed.todos, []);
  assert.match(feed.error, /Cannot read/);
  assert.equal(await feed.refresh(), false);
  value = plan();
  assert.equal(await feed.refresh(), true);
  assert.equal(feed.error, "");
});

test("remote reads receive the correct machine, and unbound sessions never read files", async () => {
  const calls = [];
  const feed = new TodoFeed(async (path, options) => { calls.push({ path, options }); return plan(); });
  feed.select(resolveSession(null, []));
  assert.equal(await feed.refresh(), false);
  assert.equal(calls.length, 0);
  feed.select(context("one", "remote/t9"));
  await feed.refresh();
  assert.deepEqual(calls, [{ path: "/repo/.pi/todos/one.json", options: { on: "remote" } }]);
});

test("real atomic file replacements are read without rewriting the plan", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-herdr-native-test-"));
  try {
    mkdirSync(join(cwd, ".pi", "todos"), { recursive: true });
    const path = sessionPath(cwd, "one"), first = plan();
    writeFileSync(path, first);
    const feed = new TodoFeed(file => readFile(file, "utf8"));
    feed.select(resolveSession({ terminal: "t1" }, [terminal("t1", ref("one", cwd))]));
    await feed.refresh();
    assert.equal(await readFile(path, "utf8"), first);
    writeFileSync(path + ".tmp", plan("one", [{ ...todo(), status: "done" }]));
    renameSync(path + ".tmp", path);
    assert.equal(await feed.refresh(), true);
    assert.equal(feed.todos[0].status, "done");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
