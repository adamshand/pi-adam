// One-shot read-only adapter. Credentials stay inside WorkClient/Keychain;
// stdout is a versioned data envelope, never a token, stack trace or environment.
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkClient } from "../../todos/work-client.js";

export async function readIdeas(cwd, mode, client = new WorkClient()) {
  if (!["cached", "refresh"].includes(mode)) throw new Error("Invalid Ideas read mode");
  const list = mode === "cached" ? await client.cachedList(cwd) : await client.listReadOnly(cwd);
  return { version: 1, cwd, url: client.url, ...list };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cwd, mode = "refresh"] = process.argv.slice(2);
  if (!cwd || !isAbsolute(cwd) || !["cached", "refresh"].includes(mode)) {
    process.stderr.write("Usage: node read-ideas.js <absolute-cwd> cached|refresh\n");
    process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify(await readIdeas(cwd, mode)) + "\n"); }
    catch {
      process.stdout.write(JSON.stringify({ version: 1, cwd, items: [], project: null, scopeResolved: false, stale: true, fetchedAt: null, error: "Ideas reader unavailable. Check Work configuration and credentials." }) + "\n");
    }
  }
}
