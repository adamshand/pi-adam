import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, Key, matchesKey } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";

const STATE_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-adam", "state.json");
const MAX_TRACKED_COMMANDS = 200;

const StateSchema = Type.Object({
	version: Type.Literal(1),
	commands: Type.Record(Type.String(), Type.Object({
		lastUsed: Type.Number(),
		count: Type.Number(),
	})),
});

type State = Static<typeof StateSchema>;

function defaultState(): State {
	return { version: 1, commands: {} };
}

export function parseMruState(text: string): State | undefined {
	try {
		return Parse(StateSchema, JSON.parse(text));
	} catch {
		return undefined;
	}
}

function loadState(): State {
	try {
		if (!existsSync(STATE_PATH)) return defaultState();
		return parseMruState(readFileSync(STATE_PATH, "utf8")) ?? defaultState();
	} catch {
		return defaultState();
	}
}

function saveState(state: State): void {
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true });
		writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {
		// Best-effort QoL state only.
	}
}

function pruneState(state: State): void {
	const entries = Object.entries(state.commands);
	if (entries.length <= MAX_TRACKED_COMMANDS) return;
	state.commands = Object.fromEntries(entries.sort(([, a], [, b]) => b.lastUsed - a.lastUsed).slice(0, MAX_TRACKED_COMMANDS));
}

function extractSlashCommand(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/") || trimmed === "/") return undefined;
	const command = trimmed.slice(1).split(/\s+/, 1)[0]?.trim();
	if (!command || command.includes("/")) return undefined;
	return command;
}

function normalizeCommandName(value: string): string {
	return value.startsWith("/") ? value.slice(1) : value;
}

let lastTouchedCommand: string | undefined;
let lastTouchedAt = 0;

function touchCommand(state: State, textOrCommand: string): boolean {
	const command = textOrCommand.startsWith("/") ? extractSlashCommand(textOrCommand) : normalizeCommandName(textOrCommand);
	if (!command) return false;

	const now = Date.now();
	if (command === lastTouchedCommand && now - lastTouchedAt < 500) return true;
	lastTouchedCommand = command;
	lastTouchedAt = now;

	const previous = state.commands[command];
	state.commands[command] = { lastUsed: now, count: (previous?.count ?? 0) + 1 };
	pruneState(state);
	saveState(state);
	return true;
}

function isSlashCommandCompletion(lines: string[], cursorLine: number, cursorCol: number, prefix: string): boolean {
	const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
	return textBeforeCursor === prefix && prefix.startsWith("/") && !prefix.slice(1).includes(" ");
}

function sortCommandItemsByRecency(state: State, items: AutocompleteItem[]): AutocompleteItem[] {
	return items
		.map((item, index) => ({ item, index, usage: state.commands[normalizeCommandName(item.value)] }))
		.sort((a, b) => (b.usage?.lastUsed ?? 0) - (a.usage?.lastUsed ?? 0) || a.index - b.index)
		.map(({ item }) => item);
}

function createRecentCommandProvider(current: AutocompleteProvider, state: State): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!suggestions || !isSlashCommandCompletion(lines, cursorLine, cursorCol, suggestions.prefix)) return suggestions;
			return { ...suggestions, items: sortCommandItemsByRecency(state, suggestions.items) };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export function getSubmittedSlashCommand(data: string, editorText: string): string | undefined {
	return matchesKey(data, Key.enter) ? extractSlashCommand(editorText) : undefined;
}

export function registerMruFeature(pi: ExtensionAPI): void {
	const state = loadState();

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => createRecentCommandProvider(current, state));
		if (ctx.mode !== "tui") return;

		ctx.ui.onTerminalInput((data) => {
			const command = getSubmittedSlashCommand(data, ctx.ui.getEditorText());
			if (command) touchCommand(state, command);
			return undefined;
		});
	});

	pi.on("input", (event) => {
		if (event.source !== "extension") touchCommand(state, event.text);
		return { action: "continue" };
	});

	pi.registerCommand("pi-adam-mru", {
		description: "Show or reset pi-adam slash-command recency (/pi-adam-mru reset)",
		getArgumentCompletions(prefix) {
			return ["show", "reset"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			if (args.trim() === "reset") {
				state.commands = {};
				saveState(state);
				ctx.ui.notify("pi-adam: slash-command MRU reset", "info");
				return;
			}

			const lines = Object.entries(state.commands)
				.sort(([, a], [, b]) => b.lastUsed - a.lastUsed)
				.slice(0, 10)
				.map(([command, usage], index) => `${index + 1}. /${command} (${usage.count})`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "pi-adam: no slash commands used yet", "info");
		},
	});
}
