import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { readProjectNote, registerProjectNoteFeature } from "./project-note.ts";
import { resolveProjectNotes } from "../herdr/app/notes/project.js";
import { createTestExtensionApi } from "./test-extension.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "project-note-"));
	const home = join(root, "home"), repo = join(root, "repo");
	await mkdir(repo);
	execFileSync("git", ["init", "-q", repo]);
	return { root, home, repo };
}

test("note reader returns missing without creating private directories or notes", async () => {
	const { root, home, repo } = await fixture();
	try {
		const note = await readProjectNote(repo, home);
		assert.equal(note.exists, false); assert.equal(note.text, ""); assert.equal(note.truncated, false);
		assert.deepEqual((await readdir(root)).sort(), ["repo"]);
		await assert.rejects(readFile(note.path), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("reads only saved notes and shares canonical identity with subfolders/worktrees", async () => {
	const { root, home, repo } = await fixture();
	try {
		execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
		const tree = join(root, "worktree"), nested = join(repo, "nested"); await mkdir(nested);
		execFileSync("git", ["-C", repo, "worktree", "add", "-qb", "test", tree]);
		const project = await resolveProjectNotes(repo, home);
		await mkdir(dirname(project.path), { recursive: true });
		await writeFile(project.path, "Human notes\nWith exact Markdown.\n");
		for (const cwd of [repo, tree, nested]) {
			const note = await readProjectNote(cwd, home);
			assert.equal(note.path, project.path); assert.equal(note.exists, true);
			assert.equal(note.text, "Human notes\nWith exact Markdown.\n"); assert.equal(note.truncated, false);
		}
		assert.notEqual((await readProjectNote(root, home)).path, project.path);
		assert.equal(await readFile(project.path, "utf8"), "Human notes\nWith exact Markdown.\n");
		await writeFile(project.path, "");
		assert.equal((await readProjectNote(repo, home)).exists, true, "empty is not missing");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("note output is bounded by bytes/lines and cancellation never writes", async () => {
	const { root, home, repo } = await fixture();
	try {
		const project = await resolveProjectNotes(repo, home);
		await mkdir(dirname(project.path), { recursive: true });
		await writeFile(project.path, "a".repeat(48 * 1024 - 1) + "😀" + "b".repeat(100000));
		const large = await readProjectNote(repo, home);
		assert.ok(Buffer.byteLength(large.text) <= 48 * 1024); assert.equal(large.truncated, true);
		assert.ok(!large.text.includes("�"));
		await writeFile(project.path, "line\n".repeat(3000));
		const lines = await readProjectNote(repo, home);
		assert.ok(lines.text.split("\n").length <= 2000); assert.equal(lines.truncated, true);
		const controller = new AbortController(); controller.abort();
		await assert.rejects(readProjectNote(repo, home, controller.signal), { name: "AbortError" });
		assert.equal((await readFile(project.path, "utf8")).length, 15000);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("the registered tool is read-only, current-project scoped and structured for Codemode", () => {
	let name: string | undefined;
	registerProjectNoteFeature(createTestExtensionApi({
		registerTool(tool: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; parameters: { properties: object }; outputSchema: object }) {
			name = tool.name;
			assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false);
			assert.deepEqual(Object.keys(tool.parameters.properties), []);
			assert.ok(tool.outputSchema);
		},
	}));
	assert.equal(name, "read_project_note");
});
