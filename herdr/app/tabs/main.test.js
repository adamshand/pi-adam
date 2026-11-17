import assert from "node:assert/strict";
import test from "node:test";
import { loadViews, reset, state, context, textChildren } from "../test-host.js";

const { Tabs } = await loadViews();
function setup() { reset(); const tabs = new Tabs(); tabs.init(); return tabs; }

test("wheel notches switch once and smooth flicks accumulate/rate-limit", t => {
  const tabs = setup(); let now = 1000;
  t.mock.method(Date, "now", () => now);
  tabs.wheel({ delta_lines: { y: 3 }, delta: { y: 100 } });
  tabs.wheel({ delta_lines: { y: -1 }, delta: { y: -100 } });
  assert.deepEqual(state.calls.map(call => call.command), ["tab.prev", "tab.next"]);
  state.calls = [];
  for (let i = 0; i < 100; i++) { now++; tabs.wheel({ delta: { y: 1 } }); }
  assert.equal(state.calls.length, 1, "a burst of small events is not a hundred tabs");
  now += 101; tabs.wheel({ delta: { y: 5 } });
  assert.equal(state.calls.length, 2, "long swipes may continue at readable speed");
  now += 300; tabs.wheel({ delta: { y: -5 }, touch_phase: "started" });
  assert.equal(state.calls.length, 2);
  now += 101; tabs.wheel({ delta: { y: -15 } });
  assert.equal(state.calls.at(-1).command, "tab.next");
  now += 300; tabs.wheel({ delta: { y: 0 } });
  assert.equal(state.calls.length, 3);
});

test("active tab is revealed after selection, reorder and size changes", () => {
  const tabs = setup(), cx = context();
  const shown = [{ id: "a", name: "one", named: true }, { id: "b", active: true, name: "two", named: true }];
  state.spaces = [{ id: "sp", active: true, tabs: shown }];
  tabs.render(cx); assert.deepEqual(state.scrolls, [1]);
  tabs.render(cx); assert.deepEqual(state.scrolls, [1], "ordinary redraws leave scrolling alone");
  state.spaces[0].tabs.reverse(); tabs.render(cx);
  assert.deepEqual(state.scrolls, [1, 0]);
  state.elements.findLast(node => node.id === "tab-scroll").events.on_size_change({}, cx);
  assert.equal(state.scrolls.at(-1), 0);
  state.elements.findLast(node => node.id === "tab-b").events.on_size_change({}, cx);
  assert.equal(state.scrolls.at(-1), 0);
});

test("tab labels follow agent titles, preserve manual names/brackets, reject paths", () => {
  const tabs = setup(), cx = context();
  const tab = { id: "tb", name: "Pi", named: false };
  const lead = { tab: "tb", terminal: "t1", title: "◐ [ABC-12] Fix bug", program: { name: "Pi", key: "pi", agent: true } };
  state.spaces = [{ id: "sp", active: true, tabs: [tab] }]; state.panes = [lead];
  tabs.render(cx); assert.ok(textChildren().includes("[ABC-12] Fix bug"));
  for (const title of ["~/project", "/project", "C:\\project", "◐ ~/project", "t1", "user@host"]) {
    state.elements = []; lead.title = title; tabs.render(cx);
    assert.ok(textChildren().includes("Pi"), title);
  }
  state.elements = []; tab.name = "Manual"; tab.named = true; lead.title = "Other session";
  tabs.render(cx); assert.ok(textChildren().includes("Manual"));
});

test("invalid saved panels fall back without breaking tabs", () => {
  for (const value of ["{", "null", "[]", "42", '"text"']) {
    reset(); state.stored.set("panels", value);
    const tabs = new Tabs(); tabs.init(); tabs.render(context());
    assert.deepEqual(tabs.panels, {});
  }
});
