import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createIdea, createTodo, getWorkItem, listIdeas, listTodos } from "./work-item-store.js";

const boardPath = new URL("./board.js", import.meta.url);

function stripAnsi(text) {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function latestRawScreen(output) {
	return output.split("\x1b[2J").at(-1) ?? output;
}

function latestScreen(output) {
	return stripAnsi(latestRawScreen(output));
}

async function waitFor(predicate, message) {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(message);
}

function startBoard(cwd, view = "todos", statePath = "") {
	let output = "";
	const board = spawn(process.execPath, [boardPath.pathname], {
		env: {
			...process.env,
			PI_ADAM_TODO_CWD: cwd,
			PI_ADAM_TODO_SESSION_ID: "session-one",
			PI_ADAM_TODO_VIEW: view,
			PI_ADAM_TODO_STATE_PATH: statePath,
			PI_ADAM_TODO_INTERVAL_MS: "10000",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	board.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
	return { board, screen: () => latestScreen(output), rawScreen: () => latestRawScreen(output) };
}

async function stopBoard(board) {
	if (board.exitCode === null) {
		board.kill("SIGTERM");
		await new Promise((resolve) => board.once("exit", resolve));
	}
}

test("wrapped overview and focused details use the compact canonical footer", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-board-details-"));
	createTodo(cwd, {
		id: "details",
		title: "Deliver a useful outcome across the narrow board width",
		ownerSessionId: "session-one",
		createdInSessionId: "origin-session",
		intent: "Keep this concise context visible on demand.",
		progress: "One result remains.",
		checklist: [{ text: "First result", done: true }, { text: "Remaining result", done: false }],
		status: "in_progress",
		createdAt: "1",
	});
	createTodo(cwd, { id: "ready", title: "Ready outcome", status: "ready", ownerSessionId: "session-one", createdInSessionId: "origin-session", createdAt: "2" });
	createTodo(cwd, { id: "done", title: "Done outcome", status: "done", ownerSessionId: "session-one", createdInSessionId: "origin-session", createdAt: "3" });
	const { board, screen, rawScreen } = startBoard(cwd);
	try {
		await waitFor(() => screen().includes("Deliver a useful outcome"), "board did not render the Todo");
		assert.match(screen().split(/\r?\n/).filter(Boolean)[0], /^ Todos \| Ideas █+$/);
		assert.match(rawScreen(), /\x1b\[32m█+/);
		assert.match(rawScreen(), /\x1b\[33m█+/);
		assert.match(rawScreen(), /\x1b\[90m█+/);
		assert.ok(screen().includes("across the") && screen().includes("narrow board width"));
		assert.ok(screen().includes("[?] help  [alt-t] show/hide"));
		assert.ok(!screen().includes("refresh") && !screen().includes("↑↓") && !screen().includes("[k]kind"));

		board.stdin.write("?");
		await waitFor(() => screen().includes("Todo board help") && screen().includes("Double-click") && screen().includes("Delete item"), "? did not open help");
		board.stdin.write("\u001b");
		await waitFor(() => !screen().includes("Todo board help"), "Escape did not close help");

		board.stdin.write("\r");
		await waitFor(() => screen().includes("Created in origin-session") && screen().includes("First result") && screen().includes("1/2"), "Enter did not open focused details");
		assert.ok(screen().includes("[?] help  [alt-t] show/hide"));
		board.stdin.write("\u001b");
		await waitFor(() => !screen().includes("concise context"), "Escape did not close focused details");

		const click = "\x1b[<0;8;3M";
		board.stdin.write(click);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.ok(!screen().includes("concise context"), "single click unexpectedly opened details");
		board.stdin.write(click);
		await waitFor(() => screen().includes("concise context"), "double click did not open details");
		board.stdin.write(click);
		board.stdin.write(click);
		await waitFor(() => !screen().includes("concise context"), "double click did not close details");
		board.stdin.write("\x1bt");
		await waitFor(() => board.exitCode !== null, "Alt-T did not hide the board");
	} finally {
		await stopBoard(board);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("arrow keys select items and change Todo state without wrapping", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-board-arrows-"));
	createTodo(cwd, { id: "first", title: "First", status: "ready", ownerSessionId: "session-one", createdInSessionId: "session-one", createdAt: "1" });
	createTodo(cwd, { id: "second", title: "Second", status: "ready", ownerSessionId: "session-one", createdInSessionId: "session-one", createdAt: "2" });
	const { board, screen } = startBoard(cwd);
	try {
		await waitFor(() => screen().includes("First") && screen().includes("Second"), "board did not render Todos");
		board.stdin.write(" ijfpdx\u001b");
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(getWorkItem(cwd, "first").status, "ready");
		assert.equal(getWorkItem(cwd, "second").status, "ready");
		assert.ok(screen().includes("First") && screen().includes("Second"));
		board.stdin.write("\x1b[B");
		board.stdin.write("\x1b[C");
		await waitFor(() => getWorkItem(cwd, "second").status === "in_progress", "right arrow did not advance selected Todo");
		board.stdin.write("\x1b[C");
		board.stdin.write("\x1b[C");
		await waitFor(() => getWorkItem(cwd, "second").status === "done", "right arrow did not stop at done");
		board.stdin.write("\x1b[D");
		await waitFor(() => getWorkItem(cwd, "second").status === "in_progress", "left arrow did not move state backward");
		board.stdin.write("\x1b[<0;2;3M");
		await waitFor(() => getWorkItem(cwd, "second").status === "done", "clicking the item icon did not cycle state");
	} finally {
		await stopBoard(board);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Tab and clickable labels change views while k changes kind and follows the item", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-board-kind-"));
	const statePath = join(cwd, "state", "session-one.view");
	createTodo(cwd, { id: "session", title: "Session Todo", ownerSessionId: "session-one", createdInSessionId: "session-one" });
	createIdea(cwd, { id: "future", title: "Future Idea", createdInSessionId: "other-session" });
	const { board, screen } = startBoard(cwd, "todos", statePath);
	try {
		await waitFor(() => screen().includes("Session Todo"), "board did not render Todos");
		board.stdin.write("k");
		await waitFor(() => screen().includes("Session Todo") && screen().includes("Future Idea"), "k did not follow Todo into Ideas");
		assert.equal(getWorkItem(cwd, "session").kind, "idea");
		assert.match(readFileSync(statePath, "utf8"), /"view":\s*"ideas"/);
		board.stdin.write("k");
		await waitFor(() => screen().includes("Session Todo") && !screen().includes("Future Idea"), "k did not follow Idea into Todos");
		assert.equal(getWorkItem(cwd, "session").status, "ready");
		board.stdin.write("\t");
		await waitFor(() => screen().includes("Future Idea"), "Tab did not switch to Ideas");
		board.stdin.write("\x1b[<0;4;1M");
		await waitFor(() => screen().includes("Session Todo") && !screen().includes("Future Idea"), "clicking Todos did not switch views");
	} finally {
		await stopBoard(board);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Delete removes either kind and c clears done Todos only after y", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-adam-board-delete-"));
	createTodo(cwd, { id: "todo", title: "Delete Todo", status: "ready", ownerSessionId: "session-one", createdInSessionId: "session-one" });
	createTodo(cwd, { id: "done", title: "Clear Done", status: "done", ownerSessionId: "session-one", createdInSessionId: "session-one" });
	createIdea(cwd, { id: "idea", title: "Delete Idea", createdInSessionId: "session-one" });
	const { board, screen } = startBoard(cwd);
	try {
		await waitFor(() => screen().includes("Delete Todo"), "board did not render Todo");
		board.stdin.write("\x1b[3~");
		await waitFor(() => screen().includes("Delete todo"), "Delete did not request Todo confirmation");
		board.stdin.write("n");
		await waitFor(() => !screen().includes("Delete todo"), "non-y did not cancel Todo deletion");
		assert.ok(getWorkItem(cwd, "todo"));
		board.stdin.write("\x1b[3~");
		await waitFor(() => screen().includes("Delete todo"), "second Todo deletion was not requested");
		board.stdin.write("y");
		await waitFor(() => !getWorkItem(cwd, "todo"), "y did not delete Todo");

		board.stdin.write("\t");
		await waitFor(() => screen().includes("Delete Idea"), "Tab did not open Ideas");
		board.stdin.write("\x7f");
		await waitFor(() => screen().includes("Delete idea"), "macOS Delete did not request Idea confirmation");
		board.stdin.write("y");
		await waitFor(() => listIdeas(cwd).length === 0, "y did not delete Idea");

		board.stdin.write("c");
		await waitFor(() => screen().includes("Delete 1 done Todo"), "c did not request clear confirmation from Ideas");
		board.stdin.write("x");
		assert.equal(listTodos(cwd).filter((item) => item.status === "done").length, 1);
		board.stdin.write("c");
		await waitFor(() => screen().includes("Delete 1 done Todo"), "second clear was not requested");
		board.stdin.write("y");
		await waitFor(() => listTodos(cwd).length === 0, "y did not clear done Todos");
	} finally {
		await stopBoard(board);
		rmSync(cwd, { recursive: true, force: true });
	}
});
