import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { centeredFooter, readFooterGitStats } from "./footer-git.ts";
import { createTestExtensionApi } from "./test-extension.ts";

const exec = promisify(execFile);

test("Git stats sum text changes, ignore binaries, and parse upstream counts", async () => {
	const pi = createTestExtensionApi({
		async exec(_command: string, args: string[]) {
			return { code: 0, stdout: args[0] === "diff" ? "142\t38\tfile\nwith\ttabs\0-\t-\tbinary\0" : "2\t3\n" };
		},
	});
	assert.deepEqual(await readFooterGitStats(pi, "/repo"), { added: 142, removed: 38, ahead: 2, behind: 3 });
});

test("Git stats omit unavailable upstream and failed diffs", async () => {
	const pi = createTestExtensionApi({
		async exec(_command: string, args: string[]) {
			return { code: args[0] === "diff" ? 0 : 128, stdout: "" };
		},
	});
	assert.deepEqual(await readFooterGitStats(pi, "/repo"), { added: 0, removed: 0 });
	assert.equal(await readFooterGitStats(createTestExtensionApi({
		async exec() { return { code: 128, stdout: "" }; },
	}), "/repo"), undefined);
});

test("centered footer respects ANSI widths, clamps to available space, and hides on narrow terminals", () => {
	const center = "\x1b[32m+142\x1b[39m −38 ↑2 ↓3";
	const line = centeredFooter(100, "model", center, "ctx 25%")!;
	assert.equal(visibleWidth(line), 100);
	assert.equal(line.indexOf("\x1b"), Math.floor((100 - visibleWidth(center)) / 2));
	assert.equal(centeredFooter(20, "model", center, "ctx 25%"), undefined);
	assert.equal(centeredFooter(100, "model", "", "ctx 25%"), undefined);
	assert.equal(centeredFooter(30, "long model name", "+1", "ctx 25%"), "long model name  +1    ctx 25%");
});

test("real Git counts staged and unstaged net changes from HEAD, excluding untracked files", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-footer-git-"));
	const git = (...args: string[]) => exec("git", args, { cwd });
	try {
		await git("init", "-q");
		await writeFile(join(cwd, "file"), "original\n");
		await git("add", ".");
		await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
		await writeFile(join(cwd, "file"), "staged\n");
		await git("add", ".");
		await writeFile(join(cwd, "file"), "staged\nunstaged\n");
		await writeFile(join(cwd, "untracked"), "not counted\n");
		const pi = createTestExtensionApi({
			async exec(command: string, args: string[]) {
				try {
					return { code: 0, ...(await exec(command, args, { cwd })) };
				} catch {
					return { code: 128, stdout: "" };
				}
			},
		});
		assert.deepEqual(await readFooterGitStats(pi, cwd), { added: 2, removed: 1 });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
