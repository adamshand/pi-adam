import assert from "node:assert/strict";
import test from "node:test";
import { deleteForward, NoteDocument } from "./model.js";
import { loadViews, reset, state, context } from "../test-host.js";

function editor(text, start, end = start) {
  let value = text, range = { start, end }, edits = 0;
  return {
    value: () => value,
    selected_range: () => range,
    set_selected_range(next) { range = next; },
    replace(next) {
      const a = Math.min(range.start, range.end), b = Math.max(range.start, range.end);
      value = value.slice(0, a) + next + value.slice(b); range = { start: a, end: a }; edits++;
    },
    edits: () => edits,
  };
}

test("Ctrl-D deletes forward, selections and empty-line newlines without splitting emoji", () => {
  for (const [text, start, end, expected] of [
    ["abc", 0, 0, "bc"], ["abc", 1, 1, "ac"], ["abc", 1, 3, "a"], ["abc", 3, 1, "a"],
    ["before\n\nafter", 7, 7, "before\nafter"], ["\nnext", 0, 0, "next"],
    ["\r\nnext", 0, 0, "next"], ["A😀B", 1, 1, "AB"],
  ]) {
    const state = editor(text, start, end); deleteForward(state);
    assert.equal(state.value(), expected);
    assert.equal(state.edits(), 1, "one native replacement/undo step");
  }
  for (const text of ["", "last", "last\n"]) {
    const state = editor(text, text.length); deleteForward(state);
    assert.equal(state.value(), text); assert.equal(state.edits(), 0, "EOF is a no-op");
  }
});

const { Notes } = await loadViews();
test("Ctrl-D is handled only on the Notes editor focus path, without touching other chords", () => {
  reset();
  const view = new Notes(), cx = context(); view.init({}, cx);
  view.key = JSON.stringify([undefined, undefined]);
  const input = editor("\nnext", 0);
  const doc = new NoteDocument("/notes.md", async () => null, async () => {});
  view.current = { project: { name: "Project", path: "/notes.md" }, doc, state: input };
  view.render(cx);
  const handler = state.elements.find(node => node.id === "notes-editor").events.on_key_down;
  let stopped = 0;
  const eventContext = { ...cx, stop_propagation() { stopped++; } };
  handler({ keystroke: "ctrl-a" }, eventContext);
  assert.equal(stopped, 0); assert.equal(input.value(), "\nnext");
  handler({ keystroke: "ctrl-d" }, eventContext);
  assert.equal(stopped, 1); assert.equal(input.value(), "next");
  assert.deepEqual(state.calls, [], "does not send terminal input or install global bindings");
});
