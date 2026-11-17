import assert from "node:assert/strict";
import test from "node:test";
import { loadViews, reset, state, context, tick } from "../test-host.js";

const views = await loadViews();
test("checks render populated mods without helpers, watches, timers or persistent writes", async () => {
  for (const [name, View] of Object.entries(views)) {
    reset(); state.checking = true; state.active = true;
    state.spaces = [{ id: "sp", active: true, folder: "/project", tabs: [{ id: "tb", name: "Pi", named: false, active: true }] }];
    state.panes = [{ id: "pane", tab: "tb", terminal: "t1", cwd: "/project", program: { name: "Pi", agent: true } }];
    state.agents = [{ address: "t1", space: "sp", tab: "tb", status: "working", seq: 1 }];
    state.focus = { terminal: "t1", space: "sp", cwd: "/project" };
    state.props = { reader: "/reader.js" };
    const owner = "owner";
    state.terminals = [{ address: "t1", state: "live", report: { app: "pi" }, labels: {
      "pi-adam.footer": JSON.stringify({ version: 1, owner, session_id: "s1", model: "test", thinking: "high", fast: null, cost: 0, contextTokens: 0, contextWindow: 1,
        controls: { owner, session: "s1", socket: "/tmp/test", client: "client", node: "node", idle: true, actions: [], focusSpans: true, focusEpoch: 1 } }),
    } }];
    state.layout = { children: [{ id: "panel", hidden: false }, { id: "panel-body", active: "todos" }] };
    const cx = context(), view = new View();
    view.init({}, cx);
    view.render(cx);
    state.active = false;
    view.render(cx);
    if (view.close) await view.close(cx);
    await tick();
    assert.deepEqual(state.calls, [], `${name}: no host mutations or helpers`);
    assert.deepEqual(state.writes, [], `${name}: no persistent writes`);
    assert.deepEqual(state.watches, [], `${name}: no watches`);
    assert.deepEqual(state.timers, [], `${name}: no background timers`);
    assert.deepEqual(state.tasks, [], `${name}: no background tasks`);
    assert.ok(state.elements.length > 0, `${name}: still renders`);
  }
});
