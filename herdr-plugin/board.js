#!/usr/bin/env node
import { clearCompleted, cycleTodo, isCompleted, listTodos, todoState } from "./todo-store.js";
import { readScope, writeScope } from "./scope-state.js";

const cwd = process.env.PI_ADAM_TODO_CWD || process.env.PWD || process.cwd();
const sessionId = process.env.PI_ADAM_TODO_SESSION_ID || "";
const statePath = process.env.PI_ADAM_TODO_STATE_PATH || "";
let scope = readScope(statePath, process.env.PI_ADAM_TODO_SCOPE === "project" ? "project" : "session");
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
let expandedId;
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

function checklistProgress(todo) {
	const items = [...String(todo.body ?? "").matchAll(/^\s*[-*]\s+\[([ xX])\]\s+.+$/gm)];
	return { done: items.filter((match) => match[1].toLowerCase() === "x").length, total: items.length };
}

function wrapLine(text, width, continuationPrefix = "") {
	if (!text) return [""];
	const words = text.split(/\s+/);
	const lines = [];
	let line = "";
	for (const word of words) {
		if (!line) {
			line = word;
		} else if (line.length + 1 + word.length <= width) {
			line += ` ${word}`;
		} else {
			lines.push(line);
			line = `${continuationPrefix}${word}`;
		}
	}
	if (line) lines.push(line);
	return lines;
}

function todoDetailLines(todo, width) {
	const body = String(todo.body ?? "").trim();
	if (!body) return [`   ${ansi.dim}No details.${ansi.reset}`];
	const contentWidth = Math.max(8, width - 4);
	const rendered = [];
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			if (rendered.length > 0 && rendered.at(-1) !== "") rendered.push("");
			continue;
		}
		const checkbox = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
		if (checkbox) {
			const checked = checkbox[1].toLowerCase() === "x";
			const icon = checked ? `${ansi.green}✓${ansi.reset}` : `${ansi.blue}○${ansi.reset}`;
			const wrapped = wrapLine(checkbox[2], Math.max(4, contentWidth - 2), "  ");
			rendered.push(`   ${icon} ${wrapped[0]}`);
			for (const continuation of wrapped.slice(1)) rendered.push(`     ${continuation}`);
			continue;
		}
		const plain = line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "• ");
		for (const wrapped of wrapLine(plain, contentWidth)) rendered.push(`   ${ansi.dim}${wrapped}${ansi.reset}`);
	}
	while (rendered.at(-1) === "") rendered.pop();
	return rendered.length > 0 ? rendered : [`   ${ansi.dim}No details.${ansi.reset}`];
}

function setFlash(message, durationMs = 2500) {
	flash = message;
	flashUntil = Date.now() + durationMs;
}

function ensureSelection(todos) {
	if (todos.length === 0) {
		selectedId = undefined;
		expandedId = undefined;
		return -1;
	}
	let index = todos.findIndex((todo) => todo.id === selectedId);
	if (index === -1) {
		index = 0;
		selectedId = todos[0].id;
	}
	if (expandedId && !todos.some((todo) => todo.id === expandedId)) expandedId = undefined;
	return index;
}

function render() {
	// Leave the terminal's last column unused: writing into it can trigger an automatic wrap.
	const width = Math.max(8, (process.stdout.columns || 40) - 1);
	const height = Math.max(10, process.stdout.rows || 24);
	scope = readScope(statePath, scope);
	const todos = loadTodos();
	const total = todos.length;
	const done = todos.filter(isCompleted).length;
	const selectedIndex = ensureSelection(todos);
	const available = Math.max(1, height - 4);
	const expandedTodo = todos.find((todo) => todo.id === expandedId);
	const allDetailLines = expandedTodo ? todoDetailLines(expandedTodo, width) : [];
	const detailBudget = expandedTodo ? Math.min(allDetailLines.length, Math.max(1, available - 1)) : 0;
	const detailLines = allDetailLines.slice(0, detailBudget);
	if (allDetailLines.length > detailBudget && detailLines.length > 0) detailLines[detailLines.length - 1] = `   ${ansi.dim}…${ansi.reset}`;
	const taskCapacity = Math.max(1, available - detailLines.length);
	const start = selectedIndex < 0 ? 0 : Math.max(0, Math.min(selectedIndex - Math.floor(taskCapacity / 2), total - taskCapacity));
	const shown = todos.slice(start, start + taskCapacity);
	const scopeLabel = scope === "project" ? "PROJECT" : "SESSION";

	const lines = [];
	const countLabel = `${done}/${total}`;
	const barWidth = Math.max(1, Math.min(10, width - scopeLabel.length - countLabel.length - 4));
	lines.push(` ${ansi.bold}${ansi.cyan}${scopeLabel}${ansi.reset} ${bar(done, total, barWidth)} ${ansi.bold}${countLabel}${ansi.reset}`);
	lines.push(`${ansi.dim}${"─".repeat(width)}${ansi.reset}`);

	visibleRows = new Map();
	if (todos.length === 0) {
		lines.push(`${ansi.dim}${fit(` No ${scope} todos.`, width)}${ansi.reset}`);
	} else {
		for (const todo of shown) {
			const terminalRow = lines.length + 1;
			visibleRows.set(terminalRow, todo.id);
			const prefix = ` ${statusIcon(todo)} `;
			const progress = checklistProgress(todo);
			const progressLabel = progress.total > 0 ? ` ${progress.done}/${progress.total}` : "";
			const titleWidth = Math.max(6, width - visibleLength(prefix) - progressLabel.length - 1);
			const title = `${fit(todo.title, titleWidth)}${progressLabel ? `${ansi.dim}${progressLabel}${ansi.reset}` : ""}`;
			const renderedTitle = todo.id === selectedId ? `${ansi.reverse}${title}${ansi.reset}` : title;
			lines.push(`${prefix}${renderedTitle}`);
			if (todo.id === expandedId) lines.push(...detailLines);
		}
	}

	while (lines.length < height - 2) lines.push("");
	const position = selectedIndex >= 0 ? `${selectedIndex + 1}/${total}` : "0/0";
	lines.push(`${ansi.dim}${fit(` ↑↓/jk select · space cycle · d details · tab/click scope · c clear · q close · ${position}`, width)}${ansi.reset}`);
	if (confirmingClear) {
		const count = todos.filter(isCompleted).length;
		lines.push(`${ansi.yellow}${fit(` Delete ${count} completed ${scope} todo${count === 1 ? "" : "s"}? y/N`, width)}${ansi.reset}`);
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
	expandedId = undefined;
	render();
}

function toggleDetails(id = selectedId) {
	if (!id) return;
	selectedId = id;
	expandedId = expandedId === id ? undefined : id;
	confirmingClear = false;
	render();
}

function cycleSelected(id = selectedId) {
	const todo = loadTodos().find((candidate) => candidate.id === id);
	if (!todo) return;
	if (expandedId && expandedId !== id) expandedId = undefined;
	try {
		const updated = cycleTodo(todo, sessionId);
		selectedId = updated?.id ?? todo.id;
		setFlash(`${todo.title}: ${todoState(updated ?? todo).replace("_", " ")}`);
	} catch (error) {
		setFlash(`Could not update todo: ${error instanceof Error ? error.message : String(error)}`);
	}
	render();
}

function toggleScope() {
	scope = scope === "session" ? "project" : "session";
	try {
		writeScope(statePath, scope);
		confirmingClear = false;
		setFlash(`Showing ${scope} todos.`);
	} catch (error) {
		setFlash(`Could not change scope: ${error instanceof Error ? error.message : String(error)}`);
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
		if (!pressed || button !== 0) continue;
		if (row === 1 && column >= 2 && column <= 8) {
			toggleScope();
			continue;
		}
		const id = visibleRows.get(row);
		if (!id) continue;
		if (column <= 3) cycleSelected(id);
		else toggleDetails(id);
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
	if (input === "\t") toggleScope();
	else if (input.includes("\x1b[A") || input === "k") moveSelection(-1);
	else if (input.includes("\x1b[B") || input === "j") moveSelection(1);
	else if (input === " " || input === "\r") cycleSelected();
	else if (input.toLowerCase() === "d") toggleDetails();
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
