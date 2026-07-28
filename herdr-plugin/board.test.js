import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const boardPath = new URL("./board.js", import.meta.url);

function stripAnsi(text) {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function latestScreen(output) {
	return stripAnsi(output.split("\x1b[2J").at(-1) ?? output);
}

async function waitFor(predicate, message) {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(message);
}

test("checklist progress is visible and details toggle with d or a title click", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-board-details-"));
	const todoDirectory = join(cwd, ".pi", "todos");
	mkdirSync(todoDirectory, { recursive: true });
	writeFileSync(join(todoDirectory, "details.md"), `${JSON.stringify({
		id: "details",
		title: "Deliver useful outcome",
		status: "open",
		tags: ["session:session-one"],
		created_at: "details",
	}, null, 2)}\n\nKeep this concise context visible on demand.\n\n- [x] First result\n- [ ] Remaining result\n`);

	let output = "";
	const board = spawn(process.execPath, [boardPath.pathname], {
		env: {
			...process.env,
			PI_ADAM_TODO_CWD: cwd,
			PI_ADAM_TODO_SESSION_ID: "session-one",
			PI_ADAM_TODO_SCOPE: "session",
			PI_ADAM_TODO_INTERVAL_MS: "10000",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	board.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });

	try {
		await waitFor(() => latestScreen(output).includes("Deliver useful outcome"), "board did not render the todo");
		assert.match(latestScreen(output), /1\/2/);
		assert.ok(!latestScreen(output).includes("concise context"));

		board.stdin.write("d");
		await waitFor(() => latestScreen(output).includes("concise context") && latestScreen(output).includes("First result"), "d did not expand todo details");
		assert.ok(latestScreen(output).includes("Remaining result"));

		board.stdin.write("d");
		await waitFor(() => !latestScreen(output).includes("concise context"), "d did not collapse todo details");
		board.stdin.write("\x1b[<0;8;4M");
		await waitFor(() => latestScreen(output).includes("concise context"), "clicking the title did not expand todo details");
	} finally {
		board.kill("SIGTERM");
		await new Promise((resolve) => board.once("exit", resolve));
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Tab and the clickable scope label toggle between session and project todos", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-board-scope-"));
	const todoDirectory = join(cwd, ".pi", "todos");
	const statePath = join(cwd, "scope", "session-one.scope");
	mkdirSync(todoDirectory, { recursive: true });
	const add = (id, title, tags) => {
		writeFileSync(join(todoDirectory, `${id}.md`), `${JSON.stringify({ id, title, status: "open", tags, created_at: id }, null, 2)}\n\n`);
	};
	add("session", "Session task", ["session:session-one"]);
	add("project", "Project task", ["project"]);

	let output = "";
	const board = spawn(process.execPath, [boardPath.pathname], {
		env: {
			...process.env,
			PI_ADAM_TODO_CWD: cwd,
			PI_ADAM_TODO_SESSION_ID: "session-one",
			PI_ADAM_TODO_SCOPE: "session",
			PI_ADAM_TODO_STATE_PATH: statePath,
			PI_ADAM_TODO_INTERVAL_MS: "10000",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	board.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });

	try {
		await waitFor(() => latestScreen(output).includes("SESSION") && latestScreen(output).includes("Session task"), "board did not render session scope");
		assert.ok(!latestScreen(output).includes("Project task"));

		board.stdin.write("\t");
		await waitFor(() => latestScreen(output).includes("PROJECT") && latestScreen(output).includes("Project task"), "Tab did not render project scope");
		assert.equal(readFileSync(statePath, "utf8"), "project\n");

		board.stdin.write("\x1b[<0;14;1M");
		await waitFor(() => latestScreen(output).includes("SESSION") && !latestScreen(output).includes("Project task"), "clicking the scope label did not restore session scope");
		assert.equal(readFileSync(statePath, "utf8"), "session\n");
	} finally {
		board.kill("SIGTERM");
		await new Promise((resolve) => board.once("exit", resolve));
		rmSync(cwd, { recursive: true, force: true });
	}
});
