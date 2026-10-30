import assert from "node:assert/strict";
import test from "node:test";
import { todoReference, ideaReference } from "./references.js";

test("Todo references use the tool's canonical ID and readable title", () => {
  assert.equal(todoReference({ id: "12ab34cd", title: "Ship the sidebar" }), "TODO-12ab34cd — Ship the sidebar");
  assert.equal(todoReference({ id: "TODO-12ab34cd", title: "Ship" }), "TODO-12ab34cd — Ship");
});

test("Idea references retain the complete ID to avoid cross-project suffix ambiguity", () => {
  const id = "work_1234567890abcdef12345678";
  assert.equal(ideaReference({ id, title: "Investigate this" }), id + " — Investigate this");
});

test("clipboard titles remain a single readable line without changing stored content", () => {
  const item = { id: "abc", title: "  Fix\n the\t“Tasks” panel  " };
  assert.equal(todoReference(item), "TODO-abc — Fix the “Tasks” panel");
  assert.equal(item.title, "  Fix\n the\t“Tasks” panel  ");
});
