import assert from "node:assert/strict";
import test from "node:test";
import { affectsGitStatus, GitInvalidations } from "./git-events.js";

test("metadata events include commits, staging, checkout, fetch and worktree refs but ignore locks/objects/logs", () => {
  for (const path of ["HEAD", "index", "refs/heads/main", "refs/remotes/origin/main", "refs", "packed-refs", "config", "shallow", "commondir", ""]) {
    assert.equal(affectsGitStatus("/repo/.git", ["/repo/.git/" + path]), true, path);
    assert.equal(affectsGitStatus("/repo/.git", [path]), true, path);
  }
  for (const path of ["index.lock", "refs/heads/main.lock", "objects/ab/123", "objects/pack", "logs/HEAD", "FETCH_HEAD", "fsmonitor--daemon/cookie"]) {
    assert.equal(affectsGitStatus("/repo/.git", ["/repo/.git/" + path]), false, path);
  }
  assert.equal(affectsGitStatus("/repo/.git/worktrees/topic", ["/repo/.git/worktrees/topic/index"]), true);
  assert.equal(affectsGitStatus("/repo/.git", ["/repo/.git"]), true);
});

test("event bursts coalesce across repositories without idle timers or losing mid-query events", () => {
  const events = new GitInvalidations();
  const scheduled = [];
  let refreshed = 0;
  const schedule = callback => scheduled.push(callback);
  const refresh = () => refreshed++;
  assert.equal(scheduled.length, 0);
  events.changed(["repo-a", "worktree-a"], schedule, refresh);
  events.changed(["repo-a", "repo-b"], schedule, refresh);
  assert.equal(scheduled.length, 1);
  assert.equal(events.revision("repo-a"), 2);
  assert.equal(events.revision("repo-b"), 1);
  assert.equal(events.revision("worktree-a"), 1);
  const queryRevision = events.revision("repo-a");
  scheduled.shift()({});
  assert.equal(refreshed, 1);
  events.changed(["repo-a"], schedule, refresh);
  assert.notEqual(events.revision("repo-a"), queryRevision, "a query started before the event cannot mark the new state clean");
  assert.equal(scheduled.length, 1);
  scheduled.shift()({});
  assert.equal(refreshed, 2);
  assert.equal(scheduled.length, 0);
});
