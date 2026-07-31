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
			PI_ADAM_TODO_VIEW: "todos",
			PI_ADAM_TODO_INTERVAL_MS: "10000",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	board.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });

	try {
		await waitFor(() => latestScreen(output).includes("Deliver useful outcome"), "board did not render the Todo");
		const initialScreen = latestScreen(output);
		const initialLines = initialScreen.split(/\r?\n/).filter(Boolean);
		assert.match(initialLines[0], /^ TODOS .* 0\/1$/);
		assert.ok(initialLines.every((line) => line.length <= 39));
		assert.match(initialScreen, /1\/2/);
		assert.ok(!initialScreen.includes("concise context"));

		board.stdin.write("d");
		await waitFor(() => latestScreen(output).includes("concise context") && latestScreen(output).includes("First result"), "d did not expand Todo details");
		board.stdin.write("d");
		await waitFor(() => !latestScreen(output).includes("concise context"), "d did not collapse Todo details");
		board.stdin.write("\x1b[<0;8;3M");
		await waitFor(() => latestScreen(output).includes("concise context"), "clicking the title did not expand Todo details");
	} finally {
		if (board.exitCode === null) {
			board.kill("SIGTERM");
			await new Promise((resolve) => board.once("exit", resolve));
		}
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Ideas can be promoted to Todos or dismissed with confirmation", async () => {
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
		await waitFor(() => latestScreen(output).includes("Promote me"), "board did not render Ideas");
		board.stdin.write("p");
		await waitFor(() => !latestScreen(output).includes("◇ Promote me") && latestScreen(output).includes("◇ Dismiss me"), "p did not promote the selected Idea");
		const todoNames = readdirSync(join(cwd, ".pi", "todos"));
		assert.equal(todoNames.length, 1);
		const promoted = JSON.parse(readFileSync(join(cwd, ".pi", "todos", todoNames[0]), "utf8").split(/\r?\n\r?\n/, 1)[0]);
		assert.equal(promoted.title, "Promote me");
		assert.deepEqual(promoted.tags, ["session:session-one"]);

		board.stdin.write("x");
		await waitFor(() => latestScreen(output).includes("Dismiss idea"), "x did not request dismissal confirmation");
		board.stdin.write("n");
		await waitFor(() => !latestScreen(output).includes("Dismiss idea"), "n did not cancel dismissal");
		board.stdin.write("x");
		await waitFor(() => latestScreen(output).includes("Dismiss idea"), "second dismissal was not requested");
		board.stdin.write("y");
		await waitFor(() => latestScreen(output).includes("No ideas"), "confirmed dismissal did not remove the Idea");
	} finally {
		if (board.exitCode === null) {
			board.kill("SIGTERM");
			await new Promise((resolve) => board.once("exit", resolve));
		}
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Tab, i, and clickable labels navigate TODOS and IDEAS, and f defers", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-board-views-"));
	const todoDirectory = join(cwd, ".pi", "todos");
	const ideaDirectory = join(cwd, ".pi", "ideas");
	const statePath = join(cwd, "state", "session-one.view");
	mkdirSync(todoDirectory, { recursive: true });
	mkdirSync(ideaDirectory, { recursive: true });
	writeFileSync(join(todoDirectory, "session.md"), `${JSON.stringify({ id: "session", title: "Session Todo", status: "open", tags: ["session:session-one"], created_at: "session" }, null, 2)}\n\nWorth doing now.\n`);
	writeFileSync(join(ideaDirectory, "future.md"), `${JSON.stringify({ id: "future", title: "Future Idea", created_at: "future", updated_at: "future" }, null, 2)}\n\nWorth considering later.\n`);

	let output = "";
	const board = spawn(process.execPath, [boardPath.pathname], {
		env: {
			...process.env,
			PI_ADAM_TODO_CWD: cwd,
			PI_ADAM_TODO_SESSION_ID: "session-one",
			PI_ADAM_TODO_VIEW: "todos",
			PI_ADAM_TODO_STATE_PATH: statePath,
			PI_ADAM_TODO_INTERVAL_MS: "10000",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	board.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });

	try {
		await waitFor(() => latestScreen(output).includes("TODOS") && latestScreen(output).includes("Session Todo"), "board did not render TODOS");
		assert.ok(!latestScreen(output).includes("Future Idea"));
		board.stdin.write("f");
		await waitFor(() => latestScreen(output).includes("No todos"), "f did not defer the Todo");
		assert.equal(readdirSync(todoDirectory).length, 0);
		assert.equal(readdirSync(ideaDirectory).length, 2);

		board.stdin.write("\t");
		await waitFor(() => latestScreen(output).includes("Future Idea") && latestScreen(output).includes("Session Todo"), "Tab did not render IDEAS");
		assert.match(readFileSync(statePath, "utf8"), /"view":\s*"ideas"/);
		board.stdin.write("\x1b[<0;4;1M");
		await waitFor(() => latestScreen(output).includes("No todos"), "clicking TODOS did not select its view");
		board.stdin.write("i");
		await waitFor(() => latestScreen(output).includes("Future Idea"), "i did not open IDEAS");
		board.stdin.write("i");
		await waitFor(() => latestScreen(output).includes("No todos"), "i did not restore TODOS");
	} finally {
		if (board.exitCode === null) {
			board.kill("SIGTERM");
			await new Promise((resolve) => board.once("exit", resolve));
		}
		rmSync(cwd, { recursive: true, force: true });
	}
});
