import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type EditorComponent,
	type EditorTheme,
	Key,
	matchesKey,
	type TUI,
} from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-adam", "state.json");
const MAX_TRACKED_COMMANDS = 200;

type CommandUsage = { lastUsed: number; count: number };
type State = { version: 1; commands: Record<string, CommandUsage> };

function defaultState(): State {
	return { version: 1, commands: {} };
}

function loadState(): State {
	try {
		if (!existsSync(STATE_PATH)) return defaultState();
		const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<State>;
		return { version: 1, commands: parsed.commands && typeof parsed.commands === "object" ? parsed.commands : {} };
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

class TrackingEditor implements EditorComponent {
	private submitHandler?: (text: string) => void;
	private changeHandler?: (text: string) => void;
	readonly actionHandlers: Map<string, () => void>;

	constructor(
		private readonly base: EditorComponent,
		private readonly onSlashSubmit: (text: string) => void,
	) {
		const maybeActionHandlers = (base as { actionHandlers?: unknown }).actionHandlers;
		this.actionHandlers = maybeActionHandlers instanceof Map ? maybeActionHandlers : new Map();
		base.onSubmit = (text: string) => {
			this.onSlashSubmit(text);
			this.submitHandler?.(text);
		};
		base.onChange = (text: string) => this.changeHandler?.(text);
	}

	get onSubmit() { return this.submitHandler; }
	set onSubmit(handler: ((text: string) => void) | undefined) { this.submitHandler = handler; }
	get onChange() { return this.changeHandler; }
	set onChange(handler: ((text: string) => void) | undefined) { this.changeHandler = handler; }
	get onEscape() { return (this.base as { onEscape?: () => void }).onEscape; }
	set onEscape(handler: (() => void) | undefined) { (this.base as { onEscape?: () => void }).onEscape = handler; }
	get onCtrlD() { return (this.base as { onCtrlD?: () => void }).onCtrlD; }
	set onCtrlD(handler: (() => void) | undefined) { (this.base as { onCtrlD?: () => void }).onCtrlD = handler; }
	get onPasteImage() { return (this.base as { onPasteImage?: () => void }).onPasteImage; }
	set onPasteImage(handler: (() => void) | undefined) { (this.base as { onPasteImage?: () => void }).onPasteImage = handler; }
	get onExtensionShortcut() { return (this.base as { onExtensionShortcut?: (data: string) => boolean }).onExtensionShortcut; }
	set onExtensionShortcut(handler: ((data: string) => boolean) | undefined) { (this.base as { onExtensionShortcut?: (data: string) => boolean }).onExtensionShortcut = handler; }
	get borderColor() { return this.base.borderColor; }
	set borderColor(color: ((str: string) => string) | undefined) { this.base.borderColor = color; }
	get wantsKeyRelease() { return (this.base as { wantsKeyRelease?: boolean }).wantsKeyRelease; }
	render(width: number) { return this.base.render(width); }
	invalidate() { this.base.invalidate(); }
	getText() { return this.base.getText(); }
	setText(text: string) { this.base.setText(text); }
	addToHistory(text: string) { this.base.addToHistory?.(text); }
	insertTextAtCursor(text: string) { this.base.insertTextAtCursor?.(text); }
	getExpandedText() { return this.base.getExpandedText?.() ?? this.base.getText(); }
	setAutocompleteProvider(provider: AutocompleteProvider) { this.base.setAutocompleteProvider?.(provider); }
	setPaddingX(padding: number) { this.base.setPaddingX?.(padding); }
	setAutocompleteMaxVisible(maxVisible: number) { this.base.setAutocompleteMaxVisible?.(maxVisible); }

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) this.onSlashSubmit(this.getExpandedText());
		this.base.handleInput(data);
	}
}

export function registerMruFeature(pi: ExtensionAPI): void {
	const state = loadState();
	let previousEditorFactory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined;
	let editorInstalled = false;

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => createRecentCommandProvider(current, state));
		if (!ctx.hasUI) return;

		previousEditorFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const base = previousEditorFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return new TrackingEditor(base, (text) => touchCommand(state, text));
		});
		editorInstalled = true;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (editorInstalled && ctx.hasUI) ctx.ui.setEditorComponent(previousEditorFactory);
		editorInstalled = false;
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
