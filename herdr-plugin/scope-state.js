import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function normalizeScope(value, fallback = "session") {
	return value === "project" || value === "session" ? value : fallback;
}

export function readScope(path, fallback = "session") {
	if (!path) return normalizeScope(fallback);
	try {
		return normalizeScope(readFileSync(path, "utf8").trim(), normalizeScope(fallback));
	} catch {
		return normalizeScope(fallback);
	}
}

export function writeScope(path, scope) {
	if (!path) return;
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, `${normalizeScope(scope)}\n`, "utf8");
	try {
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); } catch {}
		throw error;
	}
}
