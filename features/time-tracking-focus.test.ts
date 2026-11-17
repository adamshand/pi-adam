import assert from "node:assert/strict";
import test from "node:test";
import { FocusCoverage } from "./time-tracking-focus.ts";

test("late, duplicate, overlapping, future and multiple-provider spans cannot invent idle", () => {
  const focus = new FocusCoverage();
  focus.reset(100);
  const span = { providerStartedAt: 0, provider: "one", sequence: 1, start: 100, end: 200, focused: false };
  assert.deepEqual(focus.accept(span, 200), [{ start: 100, end: 200, idle: true }]);
  assert.deepEqual(focus.accept(span, 200), []);
  assert.deepEqual(focus.accept({ ...span, sequence: 2, end: 300 }, 300), []);
  assert.deepEqual(focus.accept({ ...span, sequence: 2, start: 200, end: 300 }, 299), []);
  assert.deepEqual(focus.accept({ ...span, sequence: 2, start: 200, end: 300 }, 6000), []);
  assert.deepEqual(focus.accept({ ...span, providerStartedAt: 250, provider: "two", sequence: 1, start: 250, end: 300 }, 300), [{ start: 250, end: 300, idle: true }]);
  assert.deepEqual(focus.accept({ ...span, sequence: 3, start: 300, end: 400 }, 400), []);
});

test("a newer provider retires the old generation even when its first span overlaps prior coverage", () => {
  const focus = new FocusCoverage(); focus.reset(100);
  const old = { providerStartedAt: 0, provider: "old", sequence: 1, start: 100, end: 300, focused: false };
  focus.accept(old, 300);
  assert.deepEqual(focus.accept({ ...old, providerStartedAt: 200, provider: "new", start: 200, end: 400 }, 400), [{ start: 300, end: 400, idle: true }]);
  assert.deepEqual(focus.accept({ ...old, sequence: 2, start: 400, end: 500 }, 500), []);
});
