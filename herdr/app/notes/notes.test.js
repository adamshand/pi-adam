import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { projectNotes } from "./project.js";
import { NoteDocument } from "./model.js";

test("worktrees and subfolders share notes; unrelated folders do not", async () => {
  const root = await mkdtemp(join(tmpdir(), "notes-test-"));
  try {
    const repo = join(root, "repo"), tree = join(root, "tree"), home = join(root, "home");
    await mkdir(repo); execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-qb", "test", tree]);
    await mkdir(join(repo, "nested"));
    const a = await projectNotes(repo, home);
    assert.equal((await projectNotes(tree, home)).path, a.path);
    assert.equal((await projectNotes(join(repo, "nested"), home)).path, a.path);
    assert.notEqual((await projectNotes(root, home)).path, a.path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("typing during save retains newer draft and next save uses new base", async () => {
  let finish, disk = "old", savedDraft;
  const doc = new NoteDocument("a", async () => disk, async (_path, text, expected) => {
    assert.equal(expected, disk); await new Promise(resolve => { finish = resolve; }); disk = text;
  }, null, draft => { savedDraft = draft; });
  await doc.refresh(); doc.edit("first"); const saving = doc.save(); doc.edit("second"); finish(); await saving;
  assert.equal(doc.text, "second"); assert.equal(doc.base, "first"); assert.equal(savedDraft.text, "second");
  const next = doc.save(); finish(); await next; assert.equal(disk, "second"); assert.equal(savedDraft, null);
});

test("external changes reject writes without discarding local draft", async () => {
  const doc = new NoteDocument("a", async () => "original", async () => { throw new Error("stale"); });
  await doc.refresh(); doc.edit("mine"); await doc.save();
  assert.equal(doc.text, "mine"); assert.match(doc.error, /Not saved/); assert.equal(doc.base, "original");
});

test("recovered drafts never silently overwrite external edits", async () => {
  let writes = 0;
  const doc = new NoteDocument("a", async () => "external", async () => { writes++; }, { base: "old", text: "mine" });
  await doc.refresh(); await doc.save(); assert.equal(writes, 0); assert.equal(doc.text, "mine"); assert.match(doc.error, /File changed/);
});

test("late read does not replace typing", async () => {
  let finish;
  const doc = new NoteDocument("a", () => new Promise(resolve => { finish = resolve; }), async () => {});
  const reading = doc.refresh(); doc.edit("mine"); finish("disk"); await reading;
  assert.equal(doc.text, "mine");
});
