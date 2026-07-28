import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TODO_VIEWS = ["session", "all"];
export const BOARD_VIEWS = ["session", "all", "ideas"];

export function normalizeTodoView(value, fallback = "session") {
	if (value === "project") return "all";
	return TODO_VIEWS.includes(value) ? value : (TODO_VIEWS.includes(fallback) ? fallback : "session");
}

export function normalizeBoardView(value, fallback = "session") {
	if (value === "project") return "all";
	return BOARD_VIEWS.includes(value) ? value : normalizeBoardView(fallback, "session");
}

export function readViewState(path, fallbackView = "session") {
	const fallback = normalizeBoardView(fallbackView);
	if (!path) return { view: fallback, lastTodoView: normalizeTodoView(fallback) };
	try {
		const text = readFileSync(path, "utf8").trim();
		let parsed;
		try { parsed = JSON.parse(text); } catch { parsed = { view: text }; }
		const view = normalizeBoardView(parsed.view, fallback);
		const lastTodoView = view === "ideas"
			? normalizeTodoView(parsed.lastTodoView, normalizeTodoView(fallback))
			: normalizeTodoView(view);
		return { view, lastTodoView };
	} catch {
		return { view: fallback, lastTodoView: normalizeTodoView(fallback) };
	}
}

export function writeViewState(path, state) {
	if (!path) return;
	const view = normalizeBoardView(state.view);
	const lastTodoView = view === "ideas"
		? normalizeTodoView(state.lastTodoView)
		: normalizeTodoView(view);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, `${JSON.stringify({ view, lastTodoView }, null, 2)}\n`, "utf8");
	try {
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); } catch {}
		throw error;
	}
}
