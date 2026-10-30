import assert from "node:assert/strict";
import test from "node:test";
import { FOOTER_LABEL, focusedMetrics, metricParts, visibleMetricParts } from "./model.js";

test("Git counts are optional, colored, responsive and isolated to the focused snapshot", () => {
  const data = { version: 1, owner: "runtime", session_id: "session", model: "test", thinking: "high",
    fast: null, cost: 0, contextTokens: 0, contextWindow: 1000,
    git: { added: 142, removed: 38, ahead: 2, behind: 3 } };
  const parts = metricParts(data);
  assert.deepEqual(parts.filter(part => part.kind === "git").map(({ text, tone }) => ({ text, tone })), [
    { text: "+142", tone: "done" }, { text: "−38", tone: "blocked" },
    { text: "↑2", tone: "done" }, { text: "↓3", tone: "working" },
  ]);
  assert.match(parts[2].tooltip, /upstream.*last fetched/);
  assert.equal(visibleMetricParts(parts, 600).filter(part => part.kind === "git").length, 4);
  assert.equal(visibleMetricParts(parts, 599).filter(part => part.kind === "git").length, 0);
  assert.equal(metricParts({ ...data, git: { added: 0, removed: 0 } }).some(part => part.kind === "git"), false);
  assert.equal(metricParts({ ...data, git: undefined }).some(part => part.kind === "git"), false);
  const terminal = (address, git) => ({ address, state: "live", report: { app: "pi" },
    labels: { [FOOTER_LABEL]: JSON.stringify({ ...data, git }) } });
  assert.deepEqual(focusedMetrics({ terminal: "remote/t1" }, [
    terminal("t1", { added: 999, removed: 0 }), terminal("remote/t1", data.git),
  ]).git, data.git);
});
