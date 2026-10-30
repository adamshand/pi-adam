import assert from "node:assert/strict";
import test from "node:test";
import { compactPath, updatedAt, ideaDescription } from "./ideas-format.js";

test("folder header abbreviates only a complete home-directory prefix", () => {
  assert.equal(compactPath("/Users/adam/src/harnesses/pi-adam", "/Users/adam"), "~/src/harnesses/pi-adam");
  assert.equal(compactPath("/Users/adam", "/Users/adam/"), "~");
  assert.equal(compactPath("/Users/adam-other/project", "/Users/adam"), "/Users/adam-other/project");
  assert.equal(compactPath("/remote/home/project", null), "/remote/home/project");
  assert.equal(compactPath("C:\\Users\\adam\\src", "C:\\Users\\adam"), "~\\src");
  assert.equal(compactPath(null, "/Users/adam"), "No focused folder");
});

test("Idea metadata displays a local date and time without relative-age ambiguity", () => {
  assert.equal(updatedAt(new Date(2026, 9, 30, 11, 5).toISOString()), "30 Oct 2026 · 11:05");
  assert.equal(updatedAt("bad timestamp"), "Updated time unavailable");
});

test("migration footer is omitted from display without changing the source description", () => {
  const source = "Useful description\n\n- [ ] Checklist\n\n---\nImported from Pi: `~/repo/.pi/work-items/a.json` (session `s`)\n";
  assert.equal(ideaDescription(source), "Useful description\n\n- [ ] Checklist");
  assert.match(source, /Imported from Pi:/);
  assert.equal(ideaDescription("Description\n\nImported from Pi: old.json"), "Description");
  assert.equal(ideaDescription("Description\r\n\r\n---\r\nImported from Pi: old.json"), "Description");
  assert.equal(ideaDescription("Imported from Pi: old.json"), "");
});

test("ordinary prose, quoted text and fenced examples are retained", () => {
  for (const text of [
    "Description\n---\nMore information",
    "Imported from Pi: example.json\n\nThis is a substantive paragraph afterwards.",
    "A paragraph about Imported from Pi: metadata.",
    "> Imported from Pi: this is a quotation",
    "```text\nImported from Pi: example.json",
    "```text\nImported from Pi: example.json\n```"
  ]) assert.equal(ideaDescription(text), text);
});
