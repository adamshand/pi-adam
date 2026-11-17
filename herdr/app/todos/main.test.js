import assert from "node:assert/strict";
import test from "node:test";
import { loadViews, reset, state, context, tick } from "../test-host.js";

const { Todos } = await loadViews();
function setup() {
  reset(); state.active = true;
  state.layout = { children: [{ id: "panel", hidden: false }, { id: "panel-body", active: "todos" }] };
  const view = new Todos(), cx = context(); view.init({}, cx);
  const select = path => { view.feed.context = { key: path, session: { todo_path: path } }; };
  select("/first/todos.json");
  return { view, cx, select };
}

test("switching sessions cancels an unchanged old folder without waiting for an event", async () => {
  const { view, cx, select } = setup();
  view.watch(view.feed.context, cx); assert.equal(state.watches.length, 1);
  select("/second/todos.json"); view.pruneWatches();
  assert.equal(state.watches[0].cancelled, true);
  view.watch(view.feed.context, cx); await tick();
  assert.deepEqual([...view.watching.keys()], ["/second"]);
  assert.equal(state.watches.length, 2, "cancelled old loop does not rearm");
  view.close(); await tick();
  assert.ok(state.watches.every(watch => watch.cancelled));
});

test("hiding Todos, selecting Ideas, remote context and closing release watches", async () => {
  for (const change of [
    view => { view.view = "ideas"; },
    () => { state.layout.children[0].hidden = true; },
    view => { view.feed.context.on = "remote"; },
    view => view.close(),
  ]) {
    const { view, cx } = setup();
    view.watch(view.feed.context, cx); change(view); view.pruneWatches(); await tick();
    assert.equal(state.watches[0].cancelled, true);
    assert.equal(view.watching.size, 0);
    view.watch(view.feed.context, cx);
    assert.equal(state.watches.length, 1);
  }
});

test("cancelled task cannot delete a newer watch for the same directory", async () => {
  const { view, cx, select } = setup();
  view.watch(view.feed.context, cx);
  select("/other/todos.json"); view.pruneWatches();
  select("/first/todos.json"); view.watch(view.feed.context, cx);
  await tick();
  assert.equal(view.watching.size, 1);
  assert.equal(state.watches[1].cancelled, false);
  view.close(); await tick();
});
