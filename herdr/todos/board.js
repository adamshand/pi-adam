#!/usr/bin/env node
import {
	checklistProgress,
	clearCompleted,
	cycleTodo,
	deleteWorkItem,
	isCompleted,
	listIdeas,
	listTodos,
	migrateLegacyWorkItems,
	setTodoStatus,
	toggleWorkItemKind,
} from "./work-item-store.js";
import { BOARD_VIEWS, readViewState, writeViewState } from "./view-state.js";

const cwd = process.env.PI_ADAM_TODO_CWD || process.env.PWD || process.cwd();
const sessionId = process.env.PI_ADAM_TODO_SESSION_ID || "";
const statePath = process.env.PI_ADAM_TODO_STATE_PATH || "";
const fallbackView = process.env.PI_ADAM_TODO_VIEW || "todos";
migrateLegacyWorkItems(cwd);
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
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
	white: "\x1b[37m",
};

let running = true;
let selectedId;
let detailId;
let detailScroll = 0;
let helpOpen = false;
let confirmingClear = false;
let confirmingDeleteId;
let visibleRows = new Map();
let lastItemClick = { id: undefined, at: 0 };
let lastDetailClickAt = 0;
const doubleClickMs = 350;

function loadItems() {
	if (view === "ideas") return listIdeas(cwd);
	return listTodos(cwd, { sessionId }).sort((a, b) => {
		const rank = { in_progress: 0, ready: 1, done: 2 };
		return rank[a.status] - rank[b.status] || a.createdAt.localeCompare(b.createdAt);
	});
}

function statusIcon(item) {
	if (item.kind === "idea") return `${ansi.yellow}◇${ansi.reset}`;
	if (item.status === "done") return `${ansi.green}✓${ansi.reset}`;
	if (item.status === "in_progress") return `${ansi.yellow}◐${ansi.reset}`;
	return `${ansi.gray}○${ansi.reset}`;
}

function visibleLength(text) {
	return String(text).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function fit(text, width) {
	const plain = String(text).replace(/\x1b\[[0-9;]*m/g, "");
	if (plain.length <= width) return text;
	return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function wrapText(text, width) {
	const limit = Math.max(1, width);
	const result = [];
	for (const paragraph of String(text ?? "").split(/\r?\n/)) {
		if (!paragraph.trim()) {
			result.push("");
			continue;
		}
		let line = "";
		for (const rawWord of paragraph.trim().split(/\s+/)) {
			const chunks = [];
			for (let rest = rawWord; rest.length > limit; rest = rest.slice(limit)) chunks.push(rest.slice(0, limit));
			const consumed = chunks.join("");
			const remainder = rawWord.slice(consumed.length);
			for (const word of [...chunks, ...(remainder ? [remainder] : [])]) {
				if (!line) line = word;
				else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
				else {
					result.push(line);
					line = word;
				}
			}
		}
		if (line) result.push(line);
	}
	while (result.at(-1) === "") result.pop();
	return result.length > 0 ? result : [""];
}

function segmentedBar(items, width) {
	if (items.length === 0) return `${ansi.dim}${"─".repeat(width)}${ansi.reset}`;
	const segments = [
		{ status: "done", color: ansi.green },
		{ status: "in_progress", color: ansi.yellow },
		{ status: "ready", color: ansi.gray },
	];
	const exact = segments.map((segment) => items.filter((item) => item.status === segment.status).length * width / items.length);
	const lengths = exact.map(Math.floor);
	let remaining = width - lengths.reduce((sum, value) => sum + value, 0);
	const order = exact.map((value, index) => ({ index, fraction: value - lengths[index] })).sort((a, b) => b.fraction - a.fraction);
	for (let index = 0; index < remaining; index += 1) lengths[order[index % order.length].index] += 1;
	return segments.map((segment, index) => `${segment.color}${"█".repeat(lengths[index])}`).join("") + ansi.reset;
}

function ensureSelection(items) {
	if (items.length === 0) {
		selectedId = undefined;
		detailId = undefined;
		return -1;
	}
	let index = items.findIndex((item) => item.id === selectedId);
	if (index === -1) {
		index = 0;
		selectedId = items[0].id;
	}
	if (detailId && !items.some((item) => item.id === detailId)) {
		detailId = undefined;
		detailScroll = 0;
	}
	return index;
}

function overviewBlock(item, width, selected) {
	const titleLines = wrapText(item.title, Math.max(4, width - 4));
	return titleLines.map((line, index) => {
		const prefix = index === 0 ? ` ${statusIcon(item)} ` : "   ";
		const title = selected ? `${ansi.reverse}${line}${ansi.reset}` : line;
		return { text: `${prefix}${title}`, first: index === 0 };
	});
}

function checklistLines(items, width, depth = 0) {
	const lines = [];
	for (const item of items) {
		const indent = "  ".repeat(depth);
		if (item.items?.length) {
			const progress = checklistProgress(item.items);
			const icon = progress.done === progress.total ? `${ansi.green}✓${ansi.reset}` : progress.done > 0 ? `${ansi.yellow}◐${ansi.reset}` : `${ansi.gray}○${ansi.reset}`;
			const wrapped = wrapText(item.text, Math.max(4, width - indent.length - 2));
			lines.push(`${indent}${icon} ${wrapped[0]}`);
			for (const continuation of wrapped.slice(1)) lines.push(`${indent}  ${continuation}`);
			lines.push(...checklistLines(item.items, width, depth + 1));
		} else {
			const icon = item.done ? `${ansi.green}✓${ansi.reset}` : `${ansi.gray}○${ansi.reset}`;
			const wrapped = wrapText(item.text, Math.max(4, width - indent.length - 2));
			lines.push(`${indent}${icon} ${wrapped[0]}`);
			for (const continuation of wrapped.slice(1)) lines.push(`${indent}  ${continuation}`);
		}
	}
	return lines;
}

function detailLines(item, width) {
	const lines = [];
	const state = item.kind === "idea" ? "IDEA" : item.status.replace("_", " ").toUpperCase();
	const stateColor = item.kind === "idea" ? ansi.yellow : item.status === "done" ? ansi.green : item.status === "in_progress" ? ansi.yellow : ansi.gray;
	lines.push(`${stateColor}${ansi.bold}${state}${ansi.reset}`);
	lines.push(...wrapText(item.title, width).map((line) => `${ansi.bold}${ansi.white}${line}${ansi.reset}`));
	if (item.intent) {
		lines.push("");
		lines.push(`${ansi.bold}Intent${ansi.reset}`);
		lines.push(...wrapText(item.intent, width));
	}
	if (item.progress) {
		lines.push("");
		lines.push(`${ansi.bold}Progress${ansi.reset}`);
		lines.push(...wrapText(item.progress, width));
	}
	if (item.checklist.length > 0) {
		const progress = checklistProgress(item.checklist);
		lines.push("");
		lines.push(`${ansi.bold}Checklist${ansi.reset} ${ansi.dim}${progress.done}/${progress.total}${ansi.reset}`);
		lines.push(...checklistLines(item.checklist, width));
	}
	if (!item.intent && !item.progress && item.checklist.length === 0) {
		lines.push("");
		lines.push(`${ansi.dim}No structured details.${ansi.reset}`);
	}
	lines.push("");
	const addMetadata = (value) => lines.push(...wrapText(value, width).map((line) => `${ansi.dim}${line}${ansi.reset}`));
	if (item.createdInSessionId) addMetadata(`Created in ${item.createdInSessionId}`);
	if (item.ownerSessionId) addMetadata(`Owned by ${item.ownerSessionId}`);
	if (item.createdAt) addMetadata(`Created ${item.createdAt}`);
	if (item.updatedAt) addMetadata(`Updated ${item.updatedAt}`);
	return lines;
}

const simpleFooter = " [?] help  [alt-t] show/hide";

function renderDetail(item, width, height) {
	const allLines = detailLines(item, width);
	const contentHeight = Math.max(1, height - 1);
	const maxScroll = Math.max(0, allLines.length - contentHeight);
	detailScroll = Math.max(0, Math.min(detailScroll, maxScroll));
	const lines = allLines.slice(detailScroll, detailScroll + contentHeight);
	while (lines.length < contentHeight) lines.push("");
	lines.push(`${ansi.dim}${fit(simpleFooter, width)}${ansi.reset}`);
	process.stdout.write(`\x1b[2J\x1b[H${lines.slice(0, height).join("\r\n")}`);
}

function renderHelp(width, height) {
	const help = [
		`${ansi.bold}${ansi.cyan} Todo board help${ansi.reset}`,
		`${ansi.dim}${"─".repeat(width)}${ansi.reset}`,
		`${ansi.bold} Mouse${ansi.reset}`,
		" Click       Select item or view",
		" Double-click Open/close detail",
		" Click icon   Cycle Todo state",
		" Wheel        Scroll detail",
		"",
		`${ansi.bold} Keyboard${ansi.reset}`,
		" ↑ / ↓        Select or scroll",
		" ← / →        Change Todo state",
		" Enter        Open/close detail",
		" Esc          Back",
		" Tab          Toggle view",
		" k            Toggle item kind",
		" Delete       Delete item",
		" c            Clear done Todos",
		" q            Close pane",
		"",
		" y confirms; any other key cancels.",
	];
	const lines = help.map((line) => fit(line, width)).slice(0, height - 1);
	while (lines.length < height - 1) lines.push("");
	lines.push(`${ansi.dim}${fit(simpleFooter, width)}${ansi.reset}`);
	process.stdout.write(`\x1b[2J\x1b[H${lines.join("\r\n")}`);
}

function renderOverview(items, selectedIndex, width, height) {
	const lines = [];
	const tab = (name, key) => view === key ? `${ansi.bold}${ansi.cyan}${name}${ansi.reset}` : `${ansi.dim}${name}${ansi.reset}`;
	const tabs = ` ${tab("Todos", "todos")} ${ansi.dim}|${ansi.reset} ${tab("Ideas", "ideas")}`;
	if (view === "todos") {
		const barWidth = Math.max(3, Math.min(14, width - 16));
		lines.push(`${tabs} ${segmentedBar(items, barWidth)}`);
	} else lines.push(tabs);
	lines.push(`${ansi.dim}${"─".repeat(width)}${ansi.reset}`);

	const available = Math.max(1, height - 3);
	visibleRows = new Map();
	if (items.length === 0) {
		lines.push(`${ansi.dim}${view === "ideas" ? " No ideas." : " No todos."}${ansi.reset}`);
	} else {
		const blocks = items.map((item, index) => overviewBlock(item, width, index === selectedIndex));
		let start = selectedIndex;
		let aboveHeight = 0;
		while (start > 0 && aboveHeight + blocks[start - 1].length <= Math.floor(available / 2)) {
			start -= 1;
			aboveHeight += blocks[start].length;
		}
		for (let index = start; index < items.length && lines.length < height - 1; index += 1) {
			for (const row of blocks[index]) {
				if (lines.length >= height - 1) break;
				const terminalRow = lines.length + 1;
				visibleRows.set(terminalRow, { id: items[index].id, first: row.first });
				lines.push(row.text);
			}
		}
	}

	while (lines.length < height - 1) lines.push("");
	if (confirmingDeleteId) {
		const item = items.find((candidate) => candidate.id === confirmingDeleteId);
		lines.push(`${ansi.yellow}${fit(` Delete ${item?.kind ?? "item"}${item ? ` “${item.title}”` : ""}? [y] confirm`, width)}${ansi.reset}`);
	} else if (confirmingClear) {
		const count = listTodos(cwd, { sessionId }).filter(isCompleted).length;
		lines.push(`${ansi.yellow}${fit(` Delete ${count} done Todo${count === 1 ? "" : "s"}? [y] confirm`, width)}${ansi.reset}`);
	} else {
		lines.push(`${ansi.dim}${fit(simpleFooter, width)}${ansi.reset}`);
	}
	process.stdout.write(`\x1b[2J\x1b[H${lines.slice(0, height).join("\r\n")}`);
}

function render() {
	const width = Math.max(8, (process.stdout.columns || 40) - 1);
	const height = Math.max(10, process.stdout.rows || 24);
	viewState = readViewState(statePath, view);
	view = viewState.view;
	const items = loadItems();
	const selectedIndex = ensureSelection(items);
	const detailItem = detailId ? items.find((item) => item.id === detailId) : undefined;
	if (helpOpen) renderHelp(width, height);
	else if (detailItem) renderDetail(detailItem, width, height);
	else renderOverview(items, selectedIndex, width, height);
}

function moveSelection(delta) {
	const items = loadItems();
	if (items.length === 0) return;
	const index = Math.max(0, items.findIndex((item) => item.id === selectedId));
	selectedId = items[(index + delta + items.length) % items.length].id;
	render();
}

function openDetail(id = selectedId) {
	if (!id) return;
	selectedId = id;
	detailId = id;
	detailScroll = 0;
	confirmingClear = false;
	confirmingDeleteId = undefined;
	render();
}

function closeDetail() {
	detailId = undefined;
	detailScroll = 0;
	render();
}

function scrollDetail(delta) {
	detailScroll = Math.max(0, detailScroll + delta);
	render();
}

function cycleSelected(id = selectedId) {
	const todo = loadItems().find((candidate) => candidate.id === id && candidate.kind === "todo");
	if (!todo) return;
	const updated = cycleTodo(todo);
	selectedId = updated?.id ?? todo.id;
	render();
}

function changeSelectedState(delta) {
	const todo = loadItems().find((candidate) => candidate.id === selectedId && candidate.kind === "todo");
	if (!todo) return;
	const statuses = ["ready", "in_progress", "done"];
	const current = statuses.indexOf(todo.status);
	const next = Math.max(0, Math.min(statuses.length - 1, current + delta));
	if (next === current) return;
	setTodoStatus(cwd, todo.id, statuses[next]);
	render();
}

function selectView(nextView) {
	const next = BOARD_VIEWS.includes(nextView) ? nextView : "todos";
	viewState = { view: next };
	view = next;
	selectedId = undefined;
	detailId = undefined;
	detailScroll = 0;
	confirmingClear = false;
	confirmingDeleteId = undefined;
	try { writeViewState(statePath, viewState); } catch {}
	render();
}

function cycleView() {
	const index = Math.max(0, BOARD_VIEWS.indexOf(view));
	selectView(BOARD_VIEWS[(index + 1) % BOARD_VIEWS.length]);
}

function toggleSelectedKind() {
	const item = loadItems().find((candidate) => candidate.id === selectedId);
	if (!item) return;
	const keepDetail = detailId === item.id;
	const updated = toggleWorkItemKind(cwd, item.id, sessionId);
	if (!updated) return;
	view = updated.kind === "idea" ? "ideas" : "todos";
	viewState = { view };
	writeViewState(statePath, viewState);
	selectedId = updated.id;
	detailId = keepDetail ? updated.id : undefined;
	detailScroll = 0;
	render();
}

function requestDelete() {
	if (!selectedId) return;
	confirmingDeleteId = selectedId;
	confirmingClear = false;
	detailId = undefined;
	detailScroll = 0;
	render();
}

function confirmDelete() {
	if (confirmingDeleteId) deleteWorkItem(cwd, confirmingDeleteId);
	confirmingDeleteId = undefined;
	selectedId = undefined;
	render();
}

function requestClear() {
	const count = listTodos(cwd, { sessionId }).filter(isCompleted).length;
	if (count > 0) {
		confirmingClear = true;
		confirmingDeleteId = undefined;
		detailId = undefined;
		detailScroll = 0;
	}
	render();
}

function confirmClear() {
	clearCompleted(cwd, { sessionId });
	confirmingClear = false;
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
		if (!pressed || helpOpen) continue;
		if (detailId) {
			if (button === 64) scrollDetail(-1);
			else if (button === 65) scrollDetail(1);
			else if (button === 0) {
				const now = Date.now();
				if (now - lastDetailClickAt <= doubleClickMs) {
					lastDetailClickAt = 0;
					closeDetail();
				} else lastDetailClickAt = now;
			}
			continue;
		}
		if (button !== 0) continue;
		if (row === 1) {
			if (column >= 2 && column <= 6) selectView("todos");
			else if (column >= 10 && column <= 14) selectView("ideas");
			continue;
		}
		const target = visibleRows.get(row);
		if (!target) continue;
		if (target.first && column <= 3) {
			lastItemClick = { id: undefined, at: 0 };
			cycleSelected(target.id);
			continue;
		}
		const now = Date.now();
		if (lastItemClick.id === target.id && now - lastItemClick.at <= doubleClickMs) {
			lastItemClick = { id: undefined, at: 0 };
			openDetail(target.id);
		} else {
			lastItemClick = { id: target.id, at: now };
			selectedId = target.id;
			render();
		}
	}
	return input.replace(mouse, "");
}

function cleanup() {
	if (!running) return;
	running = false;
	process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[0m\x1b[?1049l");
}

function keyTokens(input) {
	const tokens = [];
	for (let index = 0; index < input.length;) {
		const escape = ["\x1b[3~", "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1bt"].find((value) => input.startsWith(value, index));
		if (escape) {
			tokens.push(escape);
			index += escape.length;
		} else {
			tokens.push(input[index]);
			index += 1;
		}
	}
	return tokens;
}

function handleKey(input) {
	if (confirmingClear || confirmingDeleteId) {
		if (input.toLowerCase() === "y") {
			if (confirmingDeleteId) confirmDelete();
			else confirmClear();
		} else {
			confirmingClear = false;
			confirmingDeleteId = undefined;
			render();
		}
		return;
	}
	if (input === "q" || input === "\u0003" || input.toLowerCase() === "\x1bt") {
		cleanup();
		process.exit(0);
	}
	if (helpOpen) {
		if (input === "?" || input === "\u001b") {
			helpOpen = false;
			render();
		}
		return;
	}
	if (input === "?") {
		helpOpen = true;
		render();
	} else if (input === "\t") cycleView();
	else if (input.toLowerCase() === "k") toggleSelectedKind();
	else if (input === "\x1b[3~" || input === "\x7f") requestDelete();
	else if (input.toLowerCase() === "c") requestClear();
	else if (detailId) {
		if (input === "\r" || input === "\u001b") closeDetail();
		else if (input === "\x1b[A") scrollDetail(-1);
		else if (input === "\x1b[B") scrollDetail(1);
		else if (input === "\x1b[D") changeSelectedState(-1);
		else if (input === "\x1b[C") changeSelectedState(1);
	} else if (input === "\x1b[A") moveSelection(-1);
	else if (input === "\x1b[B") moveSelection(1);
	else if (input === "\x1b[D") changeSelectedState(-1);
	else if (input === "\x1b[C") changeSelectedState(1);
	else if (input === "\r") openDetail();
}

if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
	const input = handleMouse(chunk.toString("utf8"));
	for (const token of keyTokens(input)) handleKey(token);
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
