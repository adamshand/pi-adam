import assert from "node:assert/strict";
import test from "node:test";
import { FOOTER_LABEL, focusedMetrics, metricParts, visibleMetricParts, metricControl, controlInvocation } from "./model.js";

const snapshot = {
  version: 1, owner: "runtime", session_id: "session", model: "gpt-test", thinking: "high",
  fast: "on", cost: 2.5, contextTokens: 700, contextWindow: 1000, speed: 42,
  usage: { status: "stale", fiveHourUsed: 75, weeklyUsed: 95, availableResets: 3 },
};
const terminal = (address, data = snapshot) => ({ address, state: "live", report: { app: "pi" }, labels: { [FOOTER_LABEL]: JSON.stringify(data) } });

test("native metrics follow only the focused terminal, respecting replacements and remote addresses", () => {
  const other = { ...snapshot, model: "other" };
  const list = [terminal("t1"), terminal("vps/t1", other)];
  assert.equal(focusedMetrics({ terminal: "t1" }, list).model, "gpt-test");
  assert.equal(focusedMetrics({ terminal: "t1", shown: "vps/t1" }, list).model, "other");
  assert.equal(focusedMetrics({ terminal: "missing" }, list), null);
  assert.equal(focusedMetrics({ terminal: null }, list), null);
});

test("missing, dead, non-Pi, malformed and unsafe labels do not borrow another pane's metrics", () => {
  for (const item of [
    { ...terminal("t1"), state: "exited" },
    { ...terminal("t1"), report: { app: "shell" } },
    { ...terminal("t1"), labels: {} },
    terminal("t1", { ...snapshot, version: 2 }),
    terminal("t1", { ...snapshot, model: "bad\nmodel" }),
    terminal("t1", { ...snapshot, cost: -1 }),
    terminal("t1", { ...snapshot, fast: true }),
    ...[{ added: -1, removed: 0 }, { added: 1.5, removed: 0 }, { added: 1, removed: "2" }, { added: 1, removed: 2, ahead: -1 }].map(git => terminal("t1", { ...snapshot, git })),
    terminal("t1", { ...snapshot, usage: { status: "ready", weeklyUsed: "oops" } }),
  ]) assert.equal(focusedMetrics({ terminal: "t1" }, [item, terminal("t2")]), null);
});

test("controls are opt-in, capability-aware, idle-only and use the clicked terminal's machine", () => {
  const data = { ...snapshot, controls: { socket: "/tmp/private/s", owner: "controller", session: "session", client: "/repo/control-client.js", node: "/bin/node", idle: true, actions: ["model", "thinking"] } };
  assert.ok(focusedMetrics({ terminal: "t1" }, [terminal("t1", data)]));
  assert.equal(metricControl(snapshot, "model"), null);
  assert.equal(metricControl(data, "model").enabled, true);
  assert.equal(metricControl(data, "fast"), null);
  assert.equal(metricControl({ ...data, controls: { ...data.controls, idle: false } }, "thinking").enabled, false);
  const local = controlInvocation(data, "t1", "model");
  assert.equal(local.on, null);
  assert.deepEqual(local.args, ["/repo/control-client.js", "/tmp/private/s", "controller", "session", "model"]);
  assert.equal(controlInvocation(data, "vps/t1", "thinking").on, "vps");
  assert.equal(focusedMetrics({ terminal: "t1" }, [terminal("t1", { ...data, controls: { ...data.controls, session: "wrong" } })]), null);
});

test("metric text retains model, mode, speed, cost, context and rate-limit health", () => {
  const before = JSON.stringify(snapshot);
  const parts = metricParts(snapshot);
  assert.deepEqual(parts.map(part => part.text), ["gpt-test", "high", "fast", "42 t/s", "$2.50", "ctx 70.0%", "5h 75% ~", "wk 95% ~", "↺3"]);
  assert.equal(parts.find(part => part.text === "ctx 70.0%").tone, "blocked");
  assert.equal(parts.find(part => part.text === "wk 95% ~").tone, "blocked");
  assert.equal(JSON.stringify(snapshot), before);
  assert.deepEqual(visibleMetricParts(parts, 1200), parts);
  assert.deepEqual(visibleMetricParts(parts, 350).map(part => part.kind), ["model", "context"]);
  assert.deepEqual(visibleMetricParts(parts, 650).map(part => part.kind), ["model", "thinking", "fast", "cost", "context"]);
  assert.deepEqual(metricParts({ ...snapshot, fast: null, speed: undefined, contextWindow: 0, usage: { status: "error" } }).map(part => part.text), ["gpt-test", "high", "$2.50", "usage !"]);
});
