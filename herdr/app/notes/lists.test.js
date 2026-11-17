import assert from "node:assert/strict";
import test from "node:test";
import { continueList, nestListAfterTab } from "./model.js";

function editor(value, start = value.length, end = start) {
  let range = { start, end }, edits = 0;
  return {
    value: () => value,
    selected_range: () => range,
    set_selected_range(next) { range = next; },
    replace(text) {
      value = value.slice(0, range.start) + text + value.slice(range.end);
      range = { start: range.start + text.length, end: range.start + text.length }; edits++;
    },
    edits: () => edits,
  };
}
// Simulates native Enter: newline first, then our submit handler.
function enter(before, cursor = before.length) {
  const state = editor(before.slice(0, cursor) + "\n" + before.slice(cursor), cursor + 1);
  const handled = continueList(state);
  return { text: state.value(), cursor: state.selected_range().start, handled, edits: state.edits() };
}

test("Enter continues bullets, nesting, numbering and tasks", () => {
  assert.equal(enter("- item").text, "- item\n- ");
  assert.equal(enter("* item").text, "* item\n* ");
  assert.equal(enter("  - child").text, "  - child\n  - ");
  assert.equal(enter("\t- tab child").text, "\t- tab child\n\t- ");
  assert.equal(enter("9. step").text, "9. step\n10. ");
  assert.equal(enter("3) step").text, "3) step\n4) ");
  assert.equal(enter("- [x] done").text, "- [x] done\n- [ ] ");
  assert.equal(enter("-   wide").text, "-   wide\n-   ");
  const middle = enter("- first\nafter", 7);
  assert.equal(middle.text, "- first\n- \nafter"); assert.equal(middle.cursor, 10);
});

test("Enter on an empty item outdents nested items, then ends the list", () => {
  assert.deepEqual(enter("- a\n  - ").text, "- a\n- ");
  assert.deepEqual(enter("- a\n- ").text, "- a\n");
  assert.deepEqual(enter("- [ ] ").text, "");
  assert.deepEqual(enter("1. ").text, "");
});

test("Enter ignores plain text, splits with text after the cursor, and fenced code", () => {
  for (const before of ["plain", "", "-not a list", "#heading", "```\n- code"]) {
    const result = enter(before);
    assert.equal(result.handled, false, before); assert.equal(result.edits, 0);
  }
  // Splitting "- |rest": the new line keeps its text and gains a marker.
  assert.equal(enter("- rest", 2).text, "- \n- rest");
  assert.equal(enter("```\nx\n```\n- after").text, "```\nx\n```\n- after\n- ");
});

test("Tab mid-item nests the whole item; other Tabs stay native", () => {
  const tab = (before, cursor, indent = "  ") => {
    const state = editor(before.slice(0, cursor) + indent + before.slice(cursor), cursor + indent.length);
    return { handled: nestListAfterTab(before, state), text: state.value(), cursor: state.selected_range().start };
  };
  assert.deepEqual(tab("- a\n- item", 8), { handled: true, text: "- a\n  - item", cursor: 10 });
  assert.deepEqual(tab("  - child", 9), { handled: true, text: "    - child", cursor: 11 });
  assert.deepEqual(tab("1. step", 3, "\t"), { handled: true, text: "\t1. step", cursor: 4 });
  assert.equal(tab("- item", 0).handled, false, "line start is already correct");
  assert.equal(tab("plain text", 5).handled, false);
  assert.equal(tab("```\n- code", 8).handled, false);
  // Typing ordinary spaces is not a Tab: single space or non-whitespace inserts are ignored.
  const typed = editor("- ab", 3); typed.replace(" ");
  assert.equal(nestListAfterTab("- a", typed), false);
});
