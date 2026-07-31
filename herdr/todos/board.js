#!/usr/bin/env node
import { deferTodo, deleteIdea, listIdeas, promoteIdea } from "./idea-store.js";
import { clearCompleted, cycleTodo, isCompleted, listTodos, todoState } from "./todo-store.js";
import { BOARD_VIEWS, readViewState, writeViewState } from "./view-state.js";

const cwd = process.env.PI_ADAM_TODO_CWD || process.env.PWD || process.cwd();
const sessionId = process.env.PI_ADAM_TODO_SESSION_ID || "";
const statePath = process.env.PI_ADAM_TODO_STATE_PATH || "";
const fallbackView = process.env.PI_ADAM_TODO_VIEW || "todos";
let viewState = readViewState(statePath, fallbackView);
let view = viewState.view;
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
let confirmingDismissId;
let flash = "";
let flashUntil = 0;
let visibleRows = new Map();

function loadItems() {
	if (view === "ideas") return listIdeas(cwd);
	return listTodos(cwd, { sessionId }).sort((a, b) => {
		const rank = { in_progress: 0, outstanding: 1, done: 2 };
		return rank[todoState(a)] - rank[todoState(b)] || a.createdAt.localeCompare(b.createdAt);
	});
}

function statusIcon(item) {
	if (view === "ideas") return `${ansi.yellow}◇${ansi.reset}`;
	const state = todoState(item);
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
	viewState = readViewState(statePath, view);
	view = viewState.view;
	const items = loadItems();
	const total = items.length;
	const done = view === "ideas" ? 0 : items.filter(isCompleted).length;
	const selectedIndex = ensureSelection(items);
	const available = Math.max(1, height - 4);
	const expandedItem = items.find((item) => item.id === expandedId);
	const allDetailLines = expandedItem ? todoDetailLines(expandedItem, width) : [];
	const detailBudget = expandedItem ? Math.min(allDetailLines.length, Math.max(1, available - 1)) : 0;
	const detailLines = allDetailLines.slice(0, detailBudget);
	if (allDetailLines.length > detailBudget && detailLines.length > 0) detailLines[detailLines.length - 1] = `   ${ansi.dim}…${ansi.reset}`;
	const taskCapacity = Math.max(1, available - detailLines.length);
	const start = selectedIndex < 0 ? 0 : Math.max(0, Math.min(selectedIndex - Math.floor(taskCapacity / 2), total - taskCapacity));
	const shown = items.slice(start, start + taskCapacity);

	const lines = [];
	const tab = (name, key) => view === key ? `${ansi.bold}${ansi.cyan}${name}${ansi.reset}` : `${ansi.dim}${name}${ansi.reset}`;
	const tabs = ` ${tab("TODOS", "todos")} ${ansi.dim}|${ansi.reset} ${tab("IDEAS", "ideas")}`;
	if (view === "ideas") {
		lines.push(`${tabs} ${ansi.bold}${total}${ansi.reset}`);
	} else {
		const countLabel = `${done}/${total}`;
		const barWidth = Math.max(1, Math.min(10, width - 24 - countLabel.length));
		lines.push(`${tabs} ${bar(done, total, barWidth)} ${ansi.bold}${countLabel}${ansi.reset}`);
	}
	lines.push(`${ansi.dim}${"─".repeat(width)}${ansi.reset}`);

	visibleRows = new Map();
	if (items.length === 0) {
		lines.push(`${ansi.dim}${fit(view === "ideas" ? " No ideas." : " No todos.", width)}${ansi.reset}`);
	} else {
		for (const item of shown) {
			const terminalRow = lines.length + 1;
			visibleRows.set(terminalRow, item.id);
			const prefix = ` ${statusIcon(item)} `;
			const progress = checklistProgress(item);
			const progressLabel = progress.total > 0 ? ` ${progress.done}/${progress.total}` : "";
			const titleWidth = Math.max(6, width - visibleLength(prefix) - progressLabel.length - 1);
			const title = `${fit(item.title, titleWidth)}${progressLabel ? `${ansi.dim}${progressLabel}${ansi.reset}` : ""}`;
			const renderedTitle = item.id === selectedId ? `${ansi.reverse}${title}${ansi.reset}` : title;
			lines.push(`${prefix}${renderedTitle}`);
			if (item.id === expandedId) lines.push(...detailLines);
		}
	}

	while (lines.length < height - 2) lines.push("");
	const position = selectedIndex >= 0 ? `${selectedIndex + 1}/${total}` : "0/0";
	const help = view === "ideas"
		? ` ↑↓/jk select · d details · p promote · x dismiss · i todos · tab views · q close · ${position}`
		: ` ↑↓/jk select · space cycle · d details · f defer · i ideas · c clear · q close · ${position}`;
	lines.push(`${ansi.dim}${fit(help, width)}${ansi.reset}`);
	if (confirmingDismissId) {
		const idea = items.find((item) => item.id === confirmingDismissId);
		lines.push(`${ansi.yellow}${fit(` Dismiss idea${idea ? ` “${idea.title}”` : ""}? y/N`, width)}${ansi.reset}`);
	} else if (confirmingClear) {
		const count = items.filter(isCompleted).length;
		lines.push(`${ansi.yellow}${fit(` Delete ${count} completed ${view} todo${count === 1 ? "" : "s"}? y/N`, width)}${ansi.reset}`);
	} else {
		if (flash && Date.now() > flashUntil) flash = "";
		lines.push(flash ? `${ansi.cyan} ${fit(flash, width - 2)}${ansi.reset}` : `${ansi.dim} ${intervalMs}ms refresh${ansi.reset}`);
	}

	process.stdout.write(`\x1b[2J\x1b[H${lines.slice(0, height).join("\r\n")}`);
}

function moveSelection(delta) {
	const items = loadItems();
	if (items.length === 0) return;
	const index = Math.max(0, items.findIndex((item) => item.id === selectedId));
	selectedId = items[(index + delta + items.length) % items.length].id;
	expandedId = undefined;
	render();
}

function toggleDetails(id = selectedId) {
	if (!id) return;
	selectedId = id;
	expandedId = expandedId === id ? undefined : id;
	confirmingClear = false;
	confirmingDismissId = undefined;
	render();
}

function cycleSelected(id = selectedId) {
	if (view === "ideas") {
		setFlash("Ideas have no completion status; press p to promote.");
		render();
		return;
	}
	const todo = loadItems().find((candidate) => candidate.id === id);
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

function selectView(nextView) {
	const next = BOARD_VIEWS.includes(nextView) ? nextView : "todos";
	viewState = { view: next };
	view = next;
	selectedId = undefined;
	expandedId = undefined;
	confirmingClear = false;
	confirmingDismissId = undefined;
	try {
		writeViewState(statePath, viewState);
		setFlash(`Showing ${view}.`);
	} catch (error) {
		setFlash(`Could not change view: ${error instanceof Error ? error.message : String(error)}`);
	}
	render();
}

function cycleView() {
	const index = Math.max(0, BOARD_VIEWS.indexOf(view));
	selectView(BOARD_VIEWS[(index + 1) % BOARD_VIEWS.length]);
}

function toggleIdeas() {
	selectView(view === "ideas" ? "todos" : "ideas");
}

function promoteSelected() {
	if (view !== "ideas" || !selectedId) return;
	const result = promoteIdea(cwd, selectedId, sessionId);
	if (result) {
		selectedId = undefined;
		expandedId = undefined;
		setFlash(`Promoted to session todo: ${result.todo.title}`);
	} else {
		setFlash("Could not promote idea.");
	}
	render();
}

function deferSelected() {
	if (view !== "todos" || !selectedId) return;
	const result = deferTodo(cwd, selectedId, sessionId);
	selectedId = undefined;
	expandedId = undefined;
	setFlash(result ? `Deferred to Ideas: ${result.idea.title}` : "Could not defer todo.");
	render();
}

function requestDismiss() {
	if (view !== "ideas" || !selectedId) return;
	confirmingDismissId = selectedId;
	confirmingClear = false;
	render();
}

function confirmDismiss() {
	const dismissed = confirmingDismissId ? deleteIdea(cwd, confirmingDismissId) : undefined;
	confirmingDismissId = undefined;
	selectedId = undefined;
	expandedId = undefined;
	setFlash(dismissed ? `Dismissed idea: ${dismissed.title}` : "Idea was already removed.");
	render();
}

function requestClear() {
	if (view === "ideas") return;
	const count = loadItems().filter(isCompleted).length;
	if (count === 0) {
		setFlash(`No completed ${view} todos to clear.`);
	} else {
		confirmingClear = true;
	}
	render();
}

function confirmClear() {
	const deleted = clearCompleted(cwd, { sessionId });
	confirmingClear = false;
	setFlash(`Cleared ${deleted.length} completed ${view} todo${deleted.length === 1 ? "" : "s"}.`);
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
		if (row === 1) {
			if (column >= 2 && column <= 6) selectView("todos");
			else if (column >= 10 && column <= 14) selectView("ideas");
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
	if (confirmingClear || confirmingDismissId) {
		if (input.toLowerCase().includes("y")) {
			if (confirmingDismissId) confirmDismiss();
			else confirmClear();
		} else if (input.toLowerCase().includes("n") || input.includes("\u001b") || input.includes("\r")) {
			confirmingClear = false;
			confirmingDismissId = undefined;
			render();
		}
		return;
	}
	if (input === "q" || input === "\u0003") {
		cleanup();
		process.exit(0);
	}
	if (input === "\t") cycleView();
	else if (input.toLowerCase() === "i") toggleIdeas();
	else if (input.includes("\x1b[A") || input === "k") moveSelection(-1);
	else if (input.includes("\x1b[B") || input === "j") moveSelection(1);
	else if (input === " " || input === "\r") cycleSelected();
	else if (input.toLowerCase() === "d") toggleDetails();
	else if (input.toLowerCase() === "f") deferSelected();
	else if (input.toLowerCase() === "p") promoteSelected();
	else if (input.toLowerCase() === "x") requestDismiss();
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
