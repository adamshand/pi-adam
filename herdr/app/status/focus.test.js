import assert from "node:assert/strict";
import test from "node:test";
import { FocusReporter, terminalFocused } from "./focus.js";

test("tab, replacement, mod pane and app activation determine terminal focus", () => {
  assert.equal(terminalFocused("t1", { terminal: "t1" }, true), true);
  assert.equal(terminalFocused("t1", { terminal: "t1" }, false), false);
  assert.equal(terminalFocused("t1", { terminal: "t2" }, true), false);
  assert.equal(terminalFocused("t1", { terminal: "t1", shown: "t2" }, true), false);
  assert.equal(terminalFocused("t2", { terminal: "t1", shown: "t2" }, true), true);
  assert.equal(terminalFocused("t1", { terminal: null }, true), false);
});

test("report closes the previous focus span; disconnect and a new provider never carry a tail", () => {
  const reporter = new FocusReporter("app", 0);
  assert.equal(reporter.observe("pi", false, 100), null);
  assert.deepEqual(reporter.observe("pi", true, 200), { provider: "app", providerStartedAt: 0, sequence: 2, start: 100, end: 200, focused: false });
  reporter.forget("pi");
  assert.equal(reporter.observe("pi", false, 300), null);
  assert.equal(reporter.observe("pi", true, 400).sequence, 4);
  assert.equal(new FocusReporter("new-app").observe("pi", false, 500), null);
});
