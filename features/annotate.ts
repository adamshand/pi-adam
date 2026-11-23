import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";

/** Superkey's Hyper (Caps Lock) sends ctrl+alt+cmd; Ghostty reports cmd as super. */
export const ANNOTATE_SHORTCUT = "ctrl+alt+super+a";

export type Reaction = "up" | "down" | "question";
export type Annotation = { kind: "reaction"; reaction: Reaction } | { kind: "comment"; text: string };

const REACTION_EMOJI = { up: "👍", down: "👎", question: "❓" } satisfies Record<Reaction, string>;

function reactionForKey(data: string): Reaction | undefined {
	switch (data) {
		case "1": return "up";
		case "2": return "down";
		case "3": return "question";
		default: return undefined;
	}
}
const PREVIEW_LINES = 4;

/** One annotation as it lands in the chat box: the quoted selection, then the reaction or comment. */
export function formatAnnotation(selection: string, annotation: Annotation): string {
	const quote = selection.trim().split("\n").map(line => line.trimEnd() ? `> ${line.trimEnd()}` : ">").join("\n");
	const note = annotation.kind === "reaction" ? REACTION_EMOJI[annotation.reaction] : annotation.text.trim();
	return `${quote}\n${note}`;
}

/** Annotations build up in the editor, separated by a blank line, so the draft stays visible and editable. */
export function appendAnnotation(draft: string, block: string): string {
	const existing = draft.trimEnd();
	return existing ? `${existing}\n\n${block}\n` : `${block}\n`;
}

/** Fullscreen pi exposes these public selection helpers on its TUI; regular mode leaves selection to the terminal. */
type SelectionHost = { hasActiveSelection(): boolean; copyActiveSelectionToClipboard(): Promise<boolean> };
function selectionHost(tui: TUI): SelectionHost | undefined {
	if (!("hasActiveSelection" in tui && "copyActiveSelectionToClipboard" in tui)) return undefined;
	// SAFETY: Both methods were just checked to exist; they are public on pi-tui's TuiAltScreen, which ctx.ui.custom passes in fullscreen mode.
	return tui as TUI & SelectionHost;
}

const PASTE_COMMANDS: [string, string[]][] = process.platform === "darwin"
	? [["pbpaste", []]]
	: [["wl-paste", ["--no-newline"]], ["xclip", ["-selection", "clipboard", "-o"]], ["xsel", ["--clipboard", "--output"]]];

function readClipboard(): Promise<string | undefined> {
	return PASTE_COMMANDS.reduce<Promise<string | undefined>>((previous, [file, args]) => previous.then(found => found ?? new Promise(resolve => {
		execFile(file, args, { timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout));
	})), Promise.resolve(undefined));
}

/** Small popover: shows what is being annotated, takes a 1/2/3 reaction or a typed comment. */
export class AnnotatePopover implements Component, Focusable {
	private readonly input = new Input({ placeholder: "type a comment…" });
	private readonly selection: string;
	private readonly theme: Theme;
	private readonly finish: (annotation: Annotation | undefined) => void;
	private isFocused = false;
	constructor(selection: string, theme: Theme, finish: (annotation: Annotation | undefined) => void) {
		this.selection = selection;
		this.theme = theme;
		this.finish = finish;
		this.input.onSubmit = value => { if (value.trim()) finish({ kind: "comment", text: value }); };
		this.input.onEscape = () => finish(undefined);
	}
	get focused(): boolean { return this.isFocused; }
	set focused(value: boolean) { this.isFocused = value; this.input.focused = value; }

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) { this.finish(undefined); return; }
		const reaction = this.input.getValue() === "" ? reactionForKey(data) : undefined;
		if (reaction) { this.finish({ kind: "reaction", reaction }); return; }
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		if (width < 8) return [];
		const inner = width - 4;
		const dim = (text: string) => this.theme.fg("dim", text);
		const lines = this.selection.trim().split("\n");
		const preview = lines.slice(0, PREVIEW_LINES).map(line => dim(truncateToWidth(`> ${line}`, inner)));
		if (lines.length > PREVIEW_LINES) preview.push(dim(`  … ${lines.length - PREVIEW_LINES} more line${lines.length - PREVIEW_LINES === 1 ? "" : "s"}`));
		const hint = dim(truncateToWidth("1 👍   2 👎   3 ❓   or type a comment · Enter add · Esc cancel", inner));
		const body = [this.theme.fg("accent", "Annotate"), ...preview, "", hint, ...this.input.render(inner)];
		const border = (text: string) => this.theme.fg("border", text);
		return [
			border(`╭${"─".repeat(width - 2)}╮`),
			...body.map(line => `${border("│")} ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} ${border("│")}`),
			border(`╰${"─".repeat(width - 2)}╯`),
		];
	}

	invalidate(): void { this.input.invalidate(); }
}

async function annotate(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	let selection: string | undefined;
	let problem: string | undefined;
	const annotation = await ctx.ui.custom<Annotation | undefined>(async (tui, theme, _keys, done) => {
		const host = selectionHost(tui);
		// Fullscreen: insist on a live selection and copy it fresh so stale clipboard text is never quoted.
		if (host && !(host.hasActiveSelection() && await host.copyActiveSelectionToClipboard())) problem = "Select text in the conversation first, then press Hyper+A.";
		else {
			selection = (await readClipboard())?.trim();
			if (!selection) problem = "Nothing selected to annotate.";
		}
		if (problem || !selection) { done(undefined); return { render: () => [], invalidate() {} }; }
		const popover = new AnnotatePopover(selection, theme, done);
		popover.focused = true;
		return popover;
	}, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "70%", minWidth: 40, margin: 1 } });
	if (problem) { ctx.ui.notify(problem, "warning"); return; }
	if (!annotation || !selection) return;
	ctx.ui.setEditorText(appendAnnotation(ctx.ui.getEditorText(), formatAnnotation(selection, annotation)));
}

export function registerAnnotateFeature(pi: ExtensionAPI): void {
	const run = (ctx: ExtensionContext) => annotate(ctx).catch(error => {
		ctx.ui.notify(error instanceof Error ? error.message : "Annotation failed.", "error");
	});
	pi.registerShortcut(ANNOTATE_SHORTCUT, { description: "Annotate the selected text (👍 👎 ❓ or a comment) into the chat box", handler: run });
	pi.registerCommand("annotate", { description: "Annotate the selected text into the chat box", handler: (_args, ctx) => run(ctx) });
}
