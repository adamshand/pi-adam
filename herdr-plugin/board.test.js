import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
		const initialScreen = latestScreen(output);
		const initialLines = initialScreen.split(/\r?\n/).filter(Boolean);
		assert.match(initialLines[0], /^ SESSION .* 0\/1$/);
		assert.ok(!initialScreen.includes("PI TASKS"));
		assert.ok(!initialScreen.includes("%"));
		assert.ok(!initialScreen.includes("unfinished"));
		assert.ok(!initialScreen.includes("click an icon"));
		assert.ok(initialLines.every((line) => line.length <= 39));
		assert.match(initialScreen, /1\/2/);
		assert.ok(!initialScreen.includes("concise context"));

		board.stdin.write("d");
		await waitFor(() => latestScreen(output).includes("concise context") && latestScreen(output).includes("First result"), "d did not expand todo details");
		assert.ok(latestScreen(output).includes("Remaining result"));

		board.stdin.write("d");
		await waitFor(() => !latestScreen(output).includes("concise context"), "d did not collapse todo details");
		board.stdin.write("\x1b[<0;8;3M");
		await waitFor(() => latestScreen(output).includes("concise context"), "clicking the title did not expand todo details");
	} finally {
		if (board.exitCode === null) {
			board.kill("SIGTERM");
			await new Promise((resolve) => board.once("exit", resolve));
		}
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ideas can be promoted to session todos or dismissed with confirmation", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-board-idea-actions-"));
	const ideaDirectory = join(cwd, ".pi", "ideas");
	mkdirSync(ideaDirectory, { recursive: true });
	const addIdea = (id, title) => {
		writeFileSync(join(ideaDirectory, `${id}.md`), `${JSON.stringify({ id, title, created_at: id, updated_at: id }, null, 2)}\n\nContext for ${title}.\n`);
	};
	addIdea("a", "Promote me");
	addIdea("b", "Dismiss me");

	let output = "";
	const board = spawn(process.execPath, [boardPath.pathname], {
		env: {
			...process.env,
			PI_ADAM_TODO_CWD: cwd,
			PI_ADAM_TODO_SESSION_ID: "session-one",
			PI_ADAM_TODO_VIEW: "ideas",
			PI_ADAM_TODO_INTERVAL_MS: "10000",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	board.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });

	try {
		await waitFor(() => latestScreen(output).includes("Promote me"), "board did not render ideas");
		board.stdin.write("p");
		await waitFor(() => !latestScreen(output).includes("◇ Promote me") && latestScreen(output).includes("◇ Dismiss me"), "p did not promote the selected idea");
		const todoNames = readdirSync(join(cwd, ".pi", "todos"));
		assert.equal(todoNames.length, 1);
		const promoted = JSON.parse(readFileSync(join(cwd, ".pi", "todos", todoNames[0]), "utf8").split(/\r?\n\r?\n/, 1)[0]);
		assert.equal(promoted.title, "Promote me");
		assert.deepEqual(promoted.tags, ["session:session-one"]);

		board.stdin.write("x");
		await waitFor(() => latestScreen(output).includes("Dismiss idea"), "x did not request dismissal confirmation");
		board.stdin.write("n");
		await waitFor(() => !latestScreen(output).includes("Dismiss idea"), "n did not cancel dismissal");
		assert.ok(latestScreen(output).includes("Dismiss me"));
		board.stdin.write("x");
		await waitFor(() => latestScreen(output).includes("Dismiss idea"), "second dismissal was not requested");
		board.stdin.write("y");
		await waitFor(() => latestScreen(output).includes("No ideas"), "confirmed dismissal did not remove the idea");
	} finally {
		if (board.exitCode === null) {
			board.kill("SIGTERM");
			await new Promise((resolve) => board.once("exit", resolve));
		}
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Tab, i, and clickable labels navigate SESSION, ALL, and IDEAS views", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-board-views-"));
	const todoDirectory = join(cwd, ".pi", "todos");
	const ideaDirectory = join(cwd, ".pi", "ideas");
	const statePath = join(cwd, "state", "session-one.view");
	mkdirSync(todoDirectory, { recursive: true });
	mkdirSync(ideaDirectory, { recursive: true });
	const add = (id, title, tags) => {
		writeFileSync(join(todoDirectory, `${id}.md`), `${JSON.stringify({ id, title, status: "open", tags, created_at: id }, null, 2)}\n\n`);
	};
	add("session", "Session task", ["session:session-one"]);
	add("other", "Other session task", ["session:session-two"]);
	writeFileSync(join(ideaDirectory, "future.md"), `${JSON.stringify({ id: "future", title: "Future possibility", created_at: "future", updated_at: "future" }, null, 2)}\n\nWorth considering later.\n`);

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
		await waitFor(() => latestScreen(output).includes("SESSION") && latestScreen(output).includes("Session task"), "board did not render SESSION view");
		assert.ok(!latestScreen(output).includes("Other session task"));
		assert.ok(!latestScreen(output).includes("Future possibility"));

		board.stdin.write("\t");
		await waitFor(() => latestScreen(output).includes("Other session task"), "Tab did not render ALL view");
		assert.match(readFileSync(statePath, "utf8"), /"view":\s*"all"/);

		board.stdin.write("\t");
		await waitFor(() => latestScreen(output).includes("Future possibility") && !latestScreen(output).includes("Session task"), "Tab did not render IDEAS view");
		assert.match(readFileSync(statePath, "utf8"), /"view":\s*"ideas"/);

		board.stdin.write("\x1b[<0;4;1M");
		await waitFor(() => latestScreen(output).includes("Session task") && !latestScreen(output).includes("Future possibility"), "clicking SESSION did not select its view");
		board.stdin.write("i");
		await waitFor(() => latestScreen(output).includes("Future possibility"), "i did not open IDEAS");
		board.stdin.write("i");
		await waitFor(() => latestScreen(output).includes("Session task"), "i did not restore the previous todo view");
	} finally {
		if (board.exitCode === null) {
			board.kill("SIGTERM");
			await new Promise((resolve) => board.once("exit", resolve));
		}
		rmSync(cwd, { recursive: true, force: true });
	}
});
