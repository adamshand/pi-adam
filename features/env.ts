import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type EnvSource = "~/.pi/env" | ".pi/env";

type ParsedValue = {
	value: string;
	expand: boolean;
};

type EnvEntry = {
	value: string;
	source: EnvSource;
	applied: boolean;
};

const GLOBAL_ENV_PATH = join(homedir(), ".pi", "env");
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPANSION = /(?<!\\)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function parseEnvFile(path: string): Map<string, ParsedValue> {
	const parsed = new Map<string, ParsedValue>();
	if (!existsSync(path)) return parsed;

	for (const originalLine of readFileSync(path, "utf8").split(/\r?\n/)) {
		let line = originalLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("export ")) line = line.slice(7).trimStart();

		const equals = line.indexOf("=");
		if (equals < 1) continue;

		const name = line.slice(0, equals).trim();
		if (!ENV_NAME.test(name)) continue;

		let raw = line.slice(equals + 1).trimStart();
		let expand = true;
		let value: string;

		if (raw.startsWith("'")) {
			const end = raw.indexOf("'", 1);
			value = end === -1 ? raw.slice(1) : raw.slice(1, end);
			expand = false;
		} else if (raw.startsWith('"')) {
			let end = 1;
			let escaped = false;
			for (; end < raw.length; end++) {
				if (raw[end] === '"' && !escaped) break;
				escaped = raw[end] === "\\" && !escaped;
				if (raw[end] !== "\\") escaped = false;
			}
			value = raw.slice(1, end).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"');
		} else {
			const comment = raw.search(/\s+#/);
			value = (comment === -1 ? raw : raw.slice(0, comment)).trimEnd();
		}

		parsed.set(name, { value, expand });
	}

	return parsed;
}

function resolveValues(raw: Map<string, ParsedValue>, base: Readonly<Record<string, string | undefined>>): Map<string, string> {
	const resolved = new Map<string, string>();
	const resolving = new Set<string>();

	const resolve = (name: string): string => {
		const cached = resolved.get(name);
		if (cached !== undefined) return cached;
		const entry = raw.get(name);
		if (!entry) return base[name] ?? "";
		if (resolving.has(name)) return "";

		resolving.add(name);
		const value = entry.expand
			? entry.value.replace(EXPANSION, (_match, braced: string | undefined, plain: string | undefined) => resolve(braced ?? plain ?? ""))
			: entry.value;
		resolving.delete(name);
		const unescaped = value.replace(/\\\$/g, "$");
		resolved.set(name, unescaped);
		return unescaped;
	};

	for (const name of raw.keys()) resolve(name);
	return resolved;
}

export function registerEnvFeature(pi: ExtensionAPI): void {
	const inheritedEnv = { ...process.env };
	let entries = new Map<string, EnvEntry>();
	let originals = new Map<string, string | undefined>();
	let applied = new Map<string, string>();

	function restoreAppliedValues(): void {
		for (const [name, value] of applied) {
			// Preserve a value changed by another extension after we loaded it.
			if (process.env[name] !== value) continue;
			const original = originals.get(name);
			if (original === undefined) delete process.env[name];
			else process.env[name] = original;
		}
		entries = new Map();
		originals = new Map();
		applied = new Map();
	}

	pi.on("session_start", (_event, ctx) => {
		restoreAppliedValues();

		const globalRaw = parseEnvFile(GLOBAL_ENV_PATH);
		const combinedRaw = new Map(globalRaw);
		const sources = new Map<string, EnvSource>([...globalRaw.keys()].map((name) => [name, "~/.pi/env"]));

		if (ctx.isProjectTrusted()) {
			const projectRaw = parseEnvFile(join(ctx.cwd, ".pi", "env"));
			for (const [name, value] of projectRaw) {
				combinedRaw.set(name, value);
				sources.set(name, ".pi/env");
			}
		}

		// Remove inherited names before expansion so shell values also win when
		// referenced by another env-file variable.
		const effectiveRaw = new Map([...combinedRaw].filter(([name]) => inheritedEnv[name] === undefined));
		const values = resolveValues(effectiveRaw, inheritedEnv);
		for (const name of combinedRaw.keys()) {
			const source = sources.get(name) ?? "~/.pi/env";
			const shellWins = inheritedEnv[name] !== undefined;
			const value = shellWins ? inheritedEnv[name] ?? "" : values.get(name) ?? "";
			entries.set(name, { value, source, applied: !shellWins });
			if (shellWins) continue;

			originals.set(name, process.env[name]);
			process.env[name] = value;
			applied.set(name, value);
		}
	});

	pi.on("session_shutdown", () => {
		restoreAppliedValues();
	});

	pi.registerCommand("env", {
		description: "Show environment variables declared by ~/.pi/env or trusted .pi/env (values redacted)",
		handler: async (_args, ctx) => {
			const lines = [...entries]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, entry]) => `${name}=••••••  [${entry.source}${entry.applied ? "" : "; shell override"}]`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "pi-adam: no env-file variables loaded", "info");
		},
	});
}
