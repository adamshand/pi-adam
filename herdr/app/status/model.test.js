import assert from "node:assert/strict";
import test from "node:test";
import { FOOTER_LABEL, focusedMetrics, metricParts, visibleMetricParts, metricControl, controlInvocation, footerTooltip, resetCreditTooltip } from "./model.js";

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

test("background quota refresh never adds/removes visible suffixes on known values", () => {
  const view = status => metricParts({ ...snapshot, usage: { ...snapshot.usage, status } }).map(({ text, tone, kind }) => ({ text, tone, kind }));
  assert.deepEqual(view("loading"), view("ready"));
  assert.ok(!view("loading").some(part => part.text.includes("…")));
  assert.ok(metricParts({ ...snapshot, usage: { status: "loading" } }).some(part => part.text === "usage …"), "initial loading still has feedback");
});

test("hover details show quota reset times and partial credit expiries instead of duplicating metrics", () => {
  const now = Date.parse("2026-11-15T00:00:00Z"), fiveHourResetAt = now / 1000 + 3600, weeklyResetAt = now / 1000 + 3 * 86400;
  const data = { ...snapshot, usage: { status: "loading", fiveHourUsed: 10, weeklyUsed: 20, fiveHourResetAt, weeklyResetAt, availableResets: 4, resetExpirations: [weeklyResetAt, null] } };
  const hover = footerTooltip(data, now);
  assert.match(hover, /5-hour quota resets:.*local time; in 1h 0m/);
  assert.match(hover, /Weekly quota resets:.*in 3d 0h/);
  assert.match(hover, /4 banked resets/); assert.match(hover, /Reset 1: expires/);
  assert.match(hover, /Reset 2: Does not expire/); assert.match(hover, /partial/); assert.match(hover, /Refreshing in background/);
  assert.ok(!hover.includes(snapshot.model)); assert.ok(!hover.includes("$2.50"));
  const parts = metricParts(data, now);
  assert.match(parts.find(part => part.text.startsWith("5h")).tooltip, /5-hour quota resets/);
  assert.match(parts.find(part => part.kind === "resets").tooltip, /expires/);
  assert.match(resetCreditTooltip({ availableResets: 1 }, now), /Expiry details not reported/);
  assert.equal(resetCreditTooltip({ availableResets: 0 }, now), "0 banked resets");
  assert.match(footerTooltip({ usage: { fiveHourResetAt: now / 1000 - 1 } }, now), /time passed/);
  assert.match(footerTooltip({ usage: {} }, now), /Not reported/);
  assert.match(footerTooltip({}, now), /not available/);
});

test("Copilot monthly usage shows as 'mo' with premium-request hover details", () => {
  const now = Date.parse("2026-11-22T00:00:00Z"), monthResetAt = Date.parse("2026-12-01T00:00:00Z") / 1000;
  const data = { ...snapshot, usage: { status: "ready", monthUsed: 8.6, monthResetAt, premiumUsed: 598, premiumEntitlement: 7000 } };
  assert.ok(focusedMetrics({ terminal: "t1" }, [terminal("t1", data)]));
  const part = metricParts(data, now).find(p => p.text.startsWith("mo "));
  assert.equal(part.text, "mo 9%"); assert.equal(part.tone, "accent");
  assert.match(part.tooltip, /598 of 7,000 premium requests used/);
  assert.match(part.tooltip, /Monthly Copilot quota resets:.*in 9d 0h/);
  assert.ok(!metricParts(data, now).some(p => /^(5h|wk) /.test(p.text)));
  assert.match(footerTooltip(data, now), /premium requests/);
  assert.doesNotMatch(footerTooltip(data, now), /5-hour/);
  assert.equal(focusedMetrics({ terminal: "t1" }, [terminal("t1", { ...snapshot, usage: { status: "ready", monthUsed: "bad" } })]), null);
});

test("new optional reset/expiry fields validate without accepting unsafe label values", () => {
  const valid = { ...snapshot, usage: { status: "ready", fiveHourResetAt: 123, weeklyResetAt: 456, resetExpirations: [789, null] } };
  assert.ok(focusedMetrics({ terminal: "t1" }, [terminal("t1", valid)]));
  for (const usage of [
    { status: "ready", fiveHourResetAt: "bad" }, { status: "ready", weeklyResetAt: -1 },
    { status: "ready", resetExpirations: ["bad"] }, { status: "ready", resetExpirations: {} },
    { status: "ready", resetExpirations: Array(65).fill(null) },
  ]) assert.equal(focusedMetrics({ terminal: "t1" }, [terminal("t1", { ...snapshot, usage })]), null);
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

test("provider label shows before the model, validates, and hides on narrow windows", () => {
  const data = { ...snapshot, provider: "copilot" };
  const parts = metricParts(data);
  const index = parts.findIndex(part => part.kind === "provider");
  assert.equal(parts[index].text, "copilot");
  assert.equal(parts[index + 1].kind, "model");
  assert.ok(!visibleMetricParts(parts, 400).some(part => part.kind === "provider"));
  assert.ok(visibleMetricParts(parts, 420).some(part => part.kind === "provider"));
  assert.equal(focusedMetrics({ terminal: "t1" }, [terminal("t1", data)]).provider, "copilot");
  assert.equal(focusedMetrics({ terminal: "t1" }, [terminal("t1", { ...data, provider: "bad\nprovider" })]), null);
  assert.ok(!metricParts(snapshot).some(part => part.kind === "provider"));
});
