// Only metadata that can change the displayed branch/staging/upstream counts.
// Ignore object packs, reflogs and lock files (including status/fsmonitor noise).
export function affectsGitStatus(root, paths) {
  const base = root.replace(/\/+$/, "");
  return paths.some(path => {
    const relative = path === base ? "" : path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
    if (relative.endsWith(".lock")) return false;
    return relative === "" || ["HEAD", "index", "packed-refs", "config", "commondir", "shallow", "refs"].includes(relative)
      || relative.startsWith("refs/");
  });
}

/** Revision guards retain events arriving during a Git query; no idle timers. */
export class GitInvalidations {
  constructor() { this.revisions = new Map(); this.pending = false; }
  revision(key) { return this.revisions.get(key) ?? 0; }
  changed(keys, schedule, refresh) {
    for (const key of keys) this.revisions.set(key, this.revision(key) + 1);
    if (this.pending) return;
    this.pending = true;
    schedule(cx => { this.pending = false; refresh(cx); });
  }
}
