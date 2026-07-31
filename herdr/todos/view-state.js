import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const BOARD_VIEWS = ["todos", "ideas"];

export function normalizeBoardView(value, fallback = "todos") {
	if (value === "session") return "todos";
	if (value === "all" || value === "project") return "ideas";
	return BOARD_VIEWS.includes(value) ? value : (BOARD_VIEWS.includes(fallback) ? fallback : "todos");
}

export function readViewState(path, fallbackView = "todos") {
	const fallback = normalizeBoardView(fallbackView);
	if (!path) return { view: fallback };
	try {
		const text = readFileSync(path, "utf8").trim();
		let parsed;
		try { parsed = JSON.parse(text); } catch { parsed = { view: text }; }
		return { view: normalizeBoardView(parsed.view, fallback) };
	} catch {
		return { view: fallback };
	}
}

export function writeViewState(path, state) {
	if (!path) return;
	const view = normalizeBoardView(state.view);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, `${JSON.stringify({ view }, null, 2)}\n`, "utf8");
	try {
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); } catch {}
		throw error;
	}
}
