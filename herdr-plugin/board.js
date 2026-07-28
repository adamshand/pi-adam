#!/usr/bin/env node
import { clearCompleted, cycleTodo, isCompleted, listTodos, todoState } from "./todo-store.js";

const cwd = process.env.PI_ADAM_TODO_CWD || process.env.PWD || process.cwd();
const sessionId = process.env.PI_ADAM_TODO_SESSION_ID || "";
const scope = process.env.PI_ADAM_TODO_SCOPE === "project" ? "project" : "session";
const intervalMs = Number(process.env.PI_ADAM_TODO_INTERVAL_MS || 700);

const ansi = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	reverse: "\x1b[7m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
	white: "\x1b[37m",
};

let running = true;
let selectedId;
let confirmingClear = false;
let flash = "";
let flashUntil = 0;
let visibleRows = new Map();

function loadTodos() {
	return listTodos(cwd, { scope, sessionId }).sort((a, b) => {
		const rank = { in_progress: 0, outstanding: 1, done: 2 };
		return rank[todoState(a)] - rank[todoState(b)] || a.createdAt.localeCompare(b.createdAt);
	});
}

function statusIcon(todo) {
	const state = todoState(todo);
	if (state === "done") return `${ansi.green}✓${ansi.reset}`;
	if (state === "in_progress") return `${ansi.cyan}◐${ansi.reset}`;
	return `${ansi.blue}○${ansi.reset}`;
}

function visibleLength(text) {
	return String(text).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function fit(text, width) {
	const plain = String(text).replace(/\x1b\[[0-9;]*m/g, "");
	if (plain.length <= width) return text;
	return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function bar(done, total, width) {
	if (total === 0) return `${ansi.dim}${"─".repeat(width)}${ansi.reset}`;
	const filled = Math.round((done / total) * width);
	return `${ansi.green}${"█".repeat(filled)}${ansi.gray}${"░".repeat(Math.max(0, width - filled))}${ansi.reset}`;
}

function setFlash(message, durationMs = 2500) {
	flash = message;
	flashUntil = Date.now() + durationMs;
}

function ensureSelection(todos) {
	if (todos.length === 0) {
		selectedId = undefined;
		return -1;
	}
	let index = todos.findIndex((todo) => todo.id === selectedId);
	if (index === -1) {
		index = 0;
		selectedId = todos[0].id;
	}
	return index;
}

function render() {
	const width = Math.max(24, process.stdout.columns || 40);
	const height = Math.max(10, process.stdout.rows || 24);
	const todos = loadTodos();
	const total = todos.length;
	const done = todos.filter(isCompleted).length;
	const active = total - done;
	const pct = total === 0 ? 0 : Math.round((done / total) * 100);
	const selectedIndex = ensureSelection(todos);
	const available = Math.max(1, height - 5);
	const start = selectedIndex < 0 ? 0 : Math.max(0, Math.min(selectedIndex - Math.floor(available / 2), total - available));
	const shown = todos.slice(start, start + available);
	const scopeLabel = scope === "project" ? "PROJECT" : "SESSION";

	const lines = [];
	lines.push(`${ansi.bold}${ansi.white} PI TASKS${ansi.reset} ${ansi.dim}· ${scopeLabel}${ansi.reset} ${bar(done, total, Math.min(10, Math.max(4, width - 35)))} ${ansi.bold}${done}/${total}${ansi.reset} ${ansi.dim}${pct}%${ansi.reset}`);
	lines.push(`${active ? `${ansi.yellow}${active} unfinished${ansi.reset}` : `${ansi.green}all clear${ansi.reset}`} ${ansi.dim}· click an icon to change status${ansi.reset}`);
	lines.push(`${ansi.dim}${"─".repeat(Math.max(4, width - 1))}${ansi.reset}`);

	visibleRows = new Map();
	if (todos.length === 0) {
		lines.push(` ${ansi.dim}No ${scope} todos.${ansi.reset}`);
	} else {
		for (const todo of shown) {
			const terminalRow = lines.length + 1;
			visibleRows.set(terminalRow, todo.id);
			const prefix = ` ${statusIcon(todo)} `;
			const titleWidth = Math.max(6, width - visibleLength(prefix) - 1);
			const title = fit(todo.title, titleWidth);
			const renderedTitle = todo.id === selectedId ? `${ansi.reverse}${title}${ansi.reset}` : title;
			lines.push(`${prefix}${renderedTitle}`);
		}
	}

	while (lines.length < height - 2) lines.push("");
	const position = selectedIndex >= 0 ? `${selectedIndex + 1}/${total}` : "0/0";
	lines.push(`${ansi.dim} ↑↓/jk select · space cycle · c clear · q close · ${position}${ansi.reset}`);
	if (confirmingClear) {
		const count = todos.filter(isCompleted).length;
		lines.push(`${ansi.yellow} Delete ${count} completed ${scope} todo${count === 1 ? "" : "s"}? y/N${ansi.reset}`);
	} else {
		if (flash && Date.now() > flashUntil) flash = "";
		lines.push(flash ? `${ansi.cyan} ${fit(flash, width - 2)}${ansi.reset}` : `${ansi.dim} ${intervalMs}ms refresh${ansi.reset}`);
	}

	process.stdout.write(`\x1b[2J\x1b[H${lines.slice(0, height).join("\r\n")}`);
}

function moveSelection(delta) {
	const todos = loadTodos();
	if (todos.length === 0) return;
	const index = Math.max(0, todos.findIndex((todo) => todo.id === selectedId));
	selectedId = todos[(index + delta + todos.length) % todos.length].id;
	render();
}

function cycleSelected(id = selectedId) {
	const todo = loadTodos().find((candidate) => candidate.id === id);
	if (!todo) return;
	try {
		const updated = cycleTodo(todo, sessionId);
		selectedId = updated?.id ?? todo.id;
		setFlash(`${todo.title}: ${todoState(updated ?? todo).replace("_", " ")}`);
	} catch (error) {
		setFlash(`Could not update todo: ${error instanceof Error ? error.message : String(error)}`);
	}
	render();
}

function requestClear() {
	const count = loadTodos().filter(isCompleted).length;
	if (count === 0) {
		setFlash(`No completed ${scope} todos to clear.`);
	} else {
		confirmingClear = true;
	}
	render();
}

function confirmClear() {
	const deleted = clearCompleted(cwd, { scope, sessionId });
	confirmingClear = false;
	setFlash(`Cleared ${deleted.length} completed ${scope} todo${deleted.length === 1 ? "" : "s"}.`);
	render();
}

function handleMouse(input) {
	const mouse = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
	let match;
	while ((match = mouse.exec(input)) !== null) {
		const button = Number(match[1]);
		const column = Number(match[2]);
		const row = Number(match[3]);
		const pressed = match[4] === "M";
		if (!pressed || button !== 0 || column > 4) continue;
		const id = visibleRows.get(row);
		if (id) cycleSelected(id);
	}
	return input.replace(mouse, "");
}

function cleanup() {
	if (!running) return;
	running = false;
	process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[0m\x1b[?1049l");
}

if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
	let input = handleMouse(chunk.toString("utf8"));
	if (!input) return;
	if (confirmingClear) {
		if (input.toLowerCase().includes("y")) confirmClear();
		else if (input.toLowerCase().includes("n") || input.includes("\u001b") || input.includes("\r")) {
			confirmingClear = false;
			render();
		}
		return;
	}
	if (input === "q" || input === "\u0003") {
		cleanup();
		process.exit(0);
	}
	if (input.includes("\x1b[A") || input === "k") moveSelection(-1);
	else if (input.includes("\x1b[B") || input === "j") moveSelection(1);
	else if (input === " " || input === "\r") cycleSelected();
	else if (input.toLowerCase() === "c") requestClear();
});

process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
process.stdout.on("resize", render);

process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
render();
setInterval(() => {
	if (running) render();
}, intervalMs);
