import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Offline identity: worktrees share their canonical git common directory.
// Never use Work's Unassigned bucket, or depend on credentials/network access.
export async function projectNotes(cwd, home = homedir()) {
  const folder = await realpath(cwd);
  let identity = folder, name = basename(folder);
  try {
    const common = execFileSync("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    identity = await realpath(common);
    name = basename(identity) === ".git" ? basename(dirname(identity)) : basename(identity);
  } catch { /* Non-repository folders each receive their own notes. */ }
  const id = `${name.replace(/[^a-zA-Z0-9_-]/g, "-")}-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
  const directory = join(home, ".pi", "projects", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { name, path: join(directory, "notes.md") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await projectNotes(process.argv[2]))); }
  catch { process.stderr.write("Cannot resolve project notes folder\n"); process.exitCode = 1; }
}
