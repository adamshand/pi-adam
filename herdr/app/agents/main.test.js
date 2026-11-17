import assert from "node:assert/strict";
import test from "node:test";
import { loadViews, reset, state, context, tick, textChildren } from "../test-host.js";

const { Agents } = await loadViews();
function setup() {
  reset();
  state.spaces = [{ id: "sp", tabs: [] }];
  state.agents = ["t1", "t2"].map(address => ({ address, space: "sp", status: "idle" }));
  state.panes = ["t1", "t2"].map(terminal => ({ terminal, cwd: "/repo" }));
  state.exec = async () => ({ code: 0, stdout: "/repo/.git\n/shared/.git\n" });
  const view = new Agents(), cx = context(); view.init({}, cx);
  return { view, cx, key: JSON.stringify([null, "/repo"]) };
}

test("shared Git watches last until their final local agent leaves", async () => {
  const { view, cx, key } = setup();
  await view.watchGit(key, "/repo", cx); await tick();
  assert.equal(state.watches.length, 2);
  state.agents.shift(); state.panes.shift();
  view.pruneGitWatches();
  assert.ok(state.watches.every(watch => !watch.cancelled));
  view.git[key] = { branch: "main" };
  state.agents = []; state.panes = [];
  view.pruneGitWatches(); await tick();
  assert.equal(view.git[key], undefined, "returning repositories refresh immediately");
  assert.ok(state.watches.every(watch => watch.cancelled));
  assert.equal(view.gitWatches.size, 0);
  assert.equal(view.gitLocations.size, 0);
  assert.equal(state.watches.length, 2, "cancelled loops never rearm");
});

test("stale discovery and cancelled loops cannot install or erase replacement watches", async () => {
  const { view, cx, key } = setup();
  let release;
  state.exec = () => new Promise(resolve => { release = resolve; });
  const discovery = view.watchGit(key, "/repo", cx);
  state.agents = []; view.pruneGitWatches();
  state.agents = [{ address: "t1", space: "sp", status: "idle" }];
  state.exec = async () => ({ code: 0, stdout: "/repo/.git\n" });
  await view.watchGit(key, "/repo", cx);
  release({ code: 0, stdout: "/obsolete/.git\n" }); await discovery;
  assert.deepEqual([...view.gitWatches.keys()], ["/repo/.git"]);
  state.agents = []; view.pruneGitWatches();
  state.agents = [{ address: "t1", space: "sp", status: "idle" }];
  await view.watchGit(key, "/repo", cx); await tick();
  assert.equal(view.gitWatches.size, 1);
  view.close(); await tick();
  assert.ok(state.watches.every(watch => watch.cancelled));
  assert.equal(view.gitWatches.size, 0);
});

test("linked worktrees share common watches while releasing private directories", async () => {
  const { view, cx, key } = setup();
  state.panes[1].cwd = "/other";
  state.exec = async (_command, _args, options) => ({ code: 0, stdout: `${options.cwd}/.git\n/shared/.git\n` });
  await view.watchGit(key, "/repo", cx);
  const other = JSON.stringify([null, "/other"]);
  await view.watchGit(other, "/other", cx); await tick();
  assert.equal(state.watches.length, 3);
  state.agents.shift(); state.panes.shift(); view.pruneGitWatches(); await tick();
  assert.deepEqual([...view.gitWatches.keys()].sort(), ["/other/.git", "/shared/.git"]);
  assert.deepEqual([...view.gitWatches.get("/shared/.git").keys], [other]);
  view.close(); await tick();
});

test("agent rows use live titles for automatic tabs, but preserve manual names and reject paths", () => {
  const { view, cx } = setup();
  state.spaces[0].tabs = [{ id: "tb", name: "Pi", named: false }];
  state.agents = [{ address: "t1", space: "sp", tab: "tb", tab_name: "Pi", status: "idle" }];
  Object.assign(state.panes[0], { tab: "tb", title: "◐ [ABC-12] Fix bug", program: { name: "Pi", key: "pi", agent: true } });
  view.render(cx); assert.ok(textChildren().includes("[ABC-12] Fix bug"));
  state.elements = []; state.panes[0].title = "◐ ~/project";
  view.render(cx); assert.ok(textChildren().includes("Pi"));
  state.elements = []; state.spaces[0].tabs[0].name = "Manual"; state.spaces[0].tabs[0].named = true;
  state.panes[0].title = "Another session";
  view.render(cx); assert.ok(textChildren().includes("Manual"));
  view.close();
});

test("failed/non-repository discovery retains the existing slow Git fallback", async t => {
  const { view, cx } = setup();
  t.mock.method(Date, "now", () => 1000);
  state.active = true;
  state.exec = async () => ({ code: 1, stdout: "" });
  view.refreshGit(cx); await tick();
  const calls = state.calls.length;
  assert.equal(calls, 2, "one status and one discovery for a shared directory");
  view.refreshGit(cx); await tick();
  assert.equal(state.calls.length, calls, "no new polling pressure on non-repositories");
  view.close();
});

test("broken and malformed saved agent state cannot break rendering", () => {
  for (const value of ["{", "null", "[]", "42", '"text"', '{"t1":null,"t2":{"s":"idle","at":"no"}}']) {
    const { view, cx } = setup();
    state.stored.set("changed", value); state.stored.set("pins", value);
    view.init({}, cx); view.render(cx); view.close();
  }
  const { view, cx } = setup();
  state.stored.set("pins", '[null,1,{},"t1"]');
  state.stored.set("changed", '{"t1":{"s":"idle","at":123}}');
  view.init({}, cx);
  assert.deepEqual(view.pins, ["t1"]);
  assert.equal(view.since({ address: "t1" }), 123);
  view.close();
});
