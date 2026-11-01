import { watch, type FSWatcher } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { affectsGitStatus } from "../herdr/app/agents/git-events.js";

/** Local Git metadata only. No worktree scan, network fetch, or idle timer. */
export async function watchFooterGit(
  pi: ExtensionAPI,
  cwd: string,
  refresh: () => void,
): Promise<() => void> {
  const result = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd, timeout: 3000 });
  if (result.code !== 0) return () => {};
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
  const changed = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = undefined; if (!stopped) refresh(); }, 400);
    timer.unref();
  };
  try {
    for (const root of new Set(result.stdout.trim().split("\n").filter(isAbsolute))) {
      const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
        if (name === null || affectsGitStatus(root, [join(root, name)])) changed();
      });
      watcher.on("error", stop);
      watchers.push(watcher);
    }
  } catch {
    // Unsupported filesystem/platform: existing lifecycle refreshes still work.
    stop();
  }
  return stop;
}
