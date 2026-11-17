import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const git = promisify(execFile);

// Read-only identity resolution is shared by the panel and the Pi tool.
// Worktrees share their canonical git common directory; no Work/network access.
export async function resolveProjectNotes(cwd, home = homedir(), signal) {
  signal?.throwIfAborted();
  const folder = await realpath(cwd);
  let identity = folder, name = basename(folder);
  try {
    const { stdout } = await git("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 3000, signal });
    identity = await realpath(stdout.trim());
    name = basename(identity) === ".git" ? basename(dirname(identity)) : basename(identity);
  } catch {
    signal?.throwIfAborted();
    // Non-repository folders each receive their own notes.
  }
  signal?.throwIfAborted();
  const id = `${name.replace(/[^a-zA-Z0-9_-]/g, "-")}-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
  return { name, path: join(home, ".pi", "projects", id, "notes.md") };
}

// The human editor opts into creating its private storage. Readers never do.
export async function projectNotes(cwd, home = homedir()) {
  const project = await resolveProjectNotes(cwd, home);
  await mkdir(dirname(project.path), { recursive: true, mode: 0o700 });
  return project;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await projectNotes(process.argv[2]))); }
  catch { process.stderr.write("Cannot resolve project notes folder\n"); process.exitCode = 1; }
}
