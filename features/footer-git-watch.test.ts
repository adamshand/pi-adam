import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchFooterGit } from "./footer-git-watch.ts";
import { createTestExtensionApi } from "./test-extension.ts";

test("footer metadata watcher refreshes without an agent turn, deduplicates shared dirs and stops cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-footer-watch-"));
  const common = join(root, ".git");
  const worktree = join(common, "worktrees", "topic");
  await mkdir(worktree, { recursive: true });
  let refreshes = 0;
  let resolveRefresh: (() => void) | undefined;
  const changed = new Promise<void>(resolve => { resolveRefresh = resolve; });
  const pi = createTestExtensionApi({
    async exec() { return { code: 0, stdout: `${worktree}\n${common}\n${common}\n` }; },
  });
  const stop = await watchFooterGit(pi, root, () => { refreshes++; resolveRefresh?.(); });
  try {
    // Simulate a commit/checkout updating the private worktree HEAD and index.
    await writeFile(join(worktree, "HEAD"), "ref: refs/heads/topic\n");
    await writeFile(join(worktree, "index"), "new index");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([changed, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Git watcher did not refresh")), 4000);
    })]).finally(() => clearTimeout(timeout));
    assert.equal(refreshes, 1, "a metadata burst should coalesce");
    stop(); stop();
    await writeFile(join(worktree, "index"), "after shutdown");
    assert.equal(refreshes, 1);
  } finally { stop(); await rm(root, { recursive: true, force: true }); }
});

test("non-repositories have an inert footer watcher", async () => {
  const pi = createTestExtensionApi({ async exec() { return { code: 128, stdout: "" }; } });
  const stop = await watchFooterGit(pi, "/not-a-repo", () => assert.fail("unexpected refresh"));
  stop(); stop();
});
