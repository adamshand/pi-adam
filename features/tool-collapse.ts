import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Fold older tool calls to a single line so the human/agent conversation stays easy to scroll back
 * through. Within the current turn the newest KEEP_OPEN calls stay fully rendered; starting a new
 * turn folds the previous turn's calls. Errors and running calls never fold, folding pauses while
 * the transcript is scrolled away from the end, and Ctrl+O or clicking a folded row expands it.
 */
export const KEEP_OPEN = 5;

const PROBE_WIDGET_KEY = "pi-adam-tool-collapse-probe";
const PREVIEW_ARG_KEYS = ["command", "path", "pattern", "query", "url", "code", "action", "target"];
const FALLBACK_RESULT_LINES = 10;

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];
type ToolResult = Parameters<RenderResult>[0];
type ResultOptions = Parameters<RenderResult>[1];
export type FoldTheme = Pick<Theme, "fg" | "bg" | "bold">;
type ToolArgs = Parameters<RenderCall>[0];

/** Decides which tool calls are folded. Pure state, no rendering. */
export class ToolFoldTracker {
	private turn: string[] = [];
	private readonly turnIds = new Set<string>();
	private readonly errors = new Set<string>();
	private readonly folded = new Set<string>();
	private readonly pending = new Set<string>();
	private readonly keepOpen: number;

	constructor(keepOpen: number = KEEP_OPEN) {
		this.keepOpen = keepOpen;
	}

	/** Record a top-level tool call of the current turn, in call order. Idempotent. */
	noteCall(id: string): void {
		if (this.turnIds.has(id)) return;
		this.turnIds.add(id);
		this.turn.push(id);
		const excess = this.turn.length - this.keepOpen;
		for (let i = 0; i < excess; i++) this.queue(this.turn[i]);
	}

	/** Errors stay readable. Returns true when an already folded row must be redrawn open. */
	noteError(id: string): boolean {
		this.errors.add(id);
		this.pending.delete(id);
		return this.folded.delete(id);
	}

	/** A new turn began: every call of the previous turn folds. */
	startTurn(): void {
		for (const id of this.turn) this.queue(id);
		this.turn = [];
		this.turnIds.clear();
	}

	/** Apply queued folds; returns the ids whose rows must be redrawn. */
	flush(): string[] {
		const ids = [...this.pending];
		for (const id of ids) this.folded.add(id);
		this.pending.clear();
		return ids;
	}

	isFolded(id: string): boolean {
		return this.folded.has(id);
	}

	/** Rebuild state for a transcript that is about to be rendered from history. */
	restore(turns: readonly (readonly string[])[], errorIds: Iterable<string>): void {
		this.turn = [];
		this.turnIds.clear();
		this.errors.clear();
		this.folded.clear();
		this.pending.clear();
		for (const id of errorIds) this.errors.add(id);
		turns.forEach((turn, index) => {
			if (index < turns.length - 1) {
				for (const id of turn) this.queue(id);
				return;
			}
			for (const id of turn) this.noteCall(id);
		});
		this.flush();
	}

	private queue(id: string | undefined): void {
		if (id === undefined || this.errors.has(id) || this.folded.has(id)) return;
		this.pending.add(id);
	}
}

/** Split a session branch into per-prompt turns of top-level tool call ids, plus errored ids. */
export type BranchToolCalls = { turns: string[][]; errorIds: string[] };

export function turnsFromBranch(entries: readonly SessionEntry[]): BranchToolCalls {
	const turns: string[][] = [[]];
	const errorIds: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!("role" in message)) continue;
		if (message.role === "user") {
			turns.push([]);
		} else if (message.role === "assistant") {
			const current = turns[turns.length - 1];
			for (const content of message.content) {
				if (content.type === "toolCall") current?.push(content.id);
			}
		} else if (message.role === "toolResult" && message.isError) {
			errorIds.push(message.toolCallId);
		}
	}
	return { turns: turns.filter((turn) => turn.length > 0), errorIds };
}

/** First meaningful argument, on one line, for the folded summary. */
export function previewArgs(args: ToolArgs): string {
	if (args === null || args === undefined) return "";
	if (Array.isArray(args) || !(args instanceof Object)) return oneLine(JSON.stringify(args) ?? "");
	const entries = Object.entries(args);
	const preferred = PREVIEW_ARG_KEYS.map((key) => entries.find(([name]) => name === key)).find(
		(entry) => entry !== undefined,
	);
	const firstString = entries.find(([, value]) => value instanceof Object === false && `${value}` === value);
	const chosen = preferred ?? firstString ?? entries[0];
	if (!chosen) return "";
	const [, value] = chosen;
	return oneLine(`${value}` === value ? value : (JSON.stringify(value) ?? ""));
}

function oneLine(text: string): string {
	const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
	const more = text.trim().includes("\n") ? " …" : "";
	return line.trim().replace(/\s+/g, " ") + more;
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** One dim line standing in for a folded tool call. */
export class FoldedToolLine implements Component {
	private cache: { width: number; line: string } | undefined;
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		if (this.cache?.width !== width) this.cache = { width, line: truncateToWidth(this.text, Math.max(1, width), "…") };
		return [this.cache.line];
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

export function foldedLine(
	toolName: string,
	args: ToolArgs,
	theme: FoldTheme,
	context: Pick<RenderContext, "isError" | "durationMs" | "outputPad">,
): FoldedToolLine {
	const icon = context.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const preview = previewArgs(args);
	const duration = formatDuration(context.durationMs);
	const text =
		" ".repeat(context.outputPad) +
		`${icon} ${theme.fg("muted", toolName)}` +
		(preview ? ` ${theme.fg("dim", preview)}` : "") +
		(duration ? theme.fg("dim", ` · ${duration}`) : "");
	return new FoldedToolLine(text);
}

/** Reproduces pi's default tool box (padding + state background) for self-framed rendering. */
export class ToolFrame implements Component {
	private child: Component | undefined;
	private bg: (text: string) => string = (text) => text;
	private bgKey = "";
	private padX = 1;
	private top = 1;
	private bottom = 1;
	private cache: { width: number; key: string; childLines: string[]; lines: string[] } | undefined;

	update(child: Component, bg: (text: string) => string, padX: number, top: number, bottom: number): void {
		this.child = child;
		this.bg = bg;
		this.bgKey = bg("x");
		this.padX = padX;
		this.top = top;
		this.bottom = bottom;
	}

	setBottom(bottom: number): void {
		this.bottom = bottom;
	}

	render(width: number): string[] {
		if (!this.child) return [];
		const innerWidth = Math.max(1, width - this.padX * 2);
		const childLines = this.child.render(innerWidth);
		const key = `${this.bgKey}|${this.padX}|${this.top}|${this.bottom}`;
		const cache = this.cache;
		if (
			cache &&
			cache.width === width &&
			cache.key === key &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		) {
			return cache.lines;
		}
		const pad = " ".repeat(this.padX);
		const fill = (line: string) => this.bg(line + " ".repeat(Math.max(0, width - visibleWidth(line))));
		const lines: string[] = [];
		for (let i = 0; i < this.top; i++) lines.push(fill(""));
		for (const line of childLines) lines.push(fill(pad + line));
		for (let i = 0; i < this.bottom; i++) lines.push(fill(""));
		this.cache = { width, key, childLines, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
		this.child?.invalidate();
	}
}

const EMPTY: Component = { render: () => [], invalidate() {} };

type RowState = {
	folded: boolean;
	callInner?: Component;
	resultInner?: Component;
	callFrame?: ToolFrame;
	resultFrame?: ToolFrame;
};

function backgroundFor(theme: FoldTheme, context: Pick<RenderContext, "isPartial" | "isError">) {
	const color = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
	return (text: string) => theme.bg(color, text);
}

function fallbackCall(toolName: string, args: ToolArgs, theme: FoldTheme): Component {
	const preview = previewArgs(args);
	return new FoldedToolLine(theme.fg("toolTitle", theme.bold(toolName)) + (preview ? ` ${theme.fg("muted", preview)}` : ""));
}

function fallbackResult(result: ToolResult, options: ResultOptions, theme: FoldTheme): Component {
	const text = result.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n")
		.trimEnd();
	if (!text) return EMPTY;
	const all = text.split("\n");
	const shown = options.expanded ? all : all.slice(0, FALLBACK_RESULT_LINES);
	const lines = shown.map((line) => theme.fg("toolOutput", line));
	if (shown.length < all.length) lines.push(theme.fg("muted", `... (${all.length - shown.length} more lines)`));
	return { render: (width) => lines.map((line) => truncateToWidth(line, width, "")), invalidate() {} };
}

export type FoldHooks = {
	isFolded(toolCallId: string): boolean;
	remember(toolCallId: string, invalidate: () => void): void;
};

/**
 * Wrap a tool's renderers. Every wrapped tool renders its own frame so a folded call costs one
 * line instead of pi's padded box. Running calls, errors and expanded rows never fold, which also
 * keeps HTML export (it renders calls as partial) complete.
 */
export function wrapToolRenderers(toolName: string, base: ToolRenderers | undefined, hooks: FoldHooks): ToolRenderers {
	const baseFramesItself = base?.renderShell === "self";
	const rows = new WeakMap<object, RowState>();
	const rowState = (context: RenderContext): RowState => {
		const key: object = context.state instanceof Object ? context.state : context;
		let state = rows.get(key);
		if (!state) {
			state = { folded: false };
			rows.set(key, state);
		}
		return state;
	};

	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			hooks.remember(context.toolCallId, context.invalidate);
			const state = rowState(context);
			state.folded =
				hooks.isFolded(context.toolCallId) && !context.isPartial && !context.isError && !context.expanded;
			if (state.folded) return foldedLine(toolName, args, theme, context);

			const inner = base?.renderCall
				? base.renderCall(args, theme, { ...context, lastComponent: state.callInner })
				: fallbackCall(toolName, args, theme);
			state.callInner = inner;
			if (baseFramesItself) return inner;
			state.callFrame ??= new ToolFrame();
			state.callFrame.update(inner, backgroundFor(theme, context), context.outputPad, 1, 1);
			return state.callFrame;
		},
		renderResult(result, options, theme, context) {
			const state = rowState(context);
			if (state.folded) return EMPTY;
			const inner = base?.renderResult
				? base.renderResult(result, options, theme, { ...context, lastComponent: state.resultInner })
				: fallbackResult(result, options, theme);
			state.resultInner = inner;
			if (baseFramesItself) return inner;
			state.callFrame?.setBottom(0);
			state.resultFrame ??= new ToolFrame();
			state.resultFrame.update(inner, backgroundFor(theme, context), context.outputPad, 0, 1);
			return state.resultFrame;
		},
	};
}

type FollowingTui = TUI & { readonly isFollowingOutput: boolean };

function reportsFollowing(tui: TUI): tui is FollowingTui {
	return "isFollowingOutput" in tui && (tui.isFollowingOutput === true || tui.isFollowingOutput === false);
}

export function registerToolCollapseFeature(pi: ExtensionAPI, keepOpen: number = KEEP_OPEN): ToolFoldTracker {
	const tracker = new ToolFoldTracker(keepOpen);
	const invalidators = new Map<string, () => void>();
	let live = false;
	let tui: TUI | undefined;

	const following = () => !tui || !reportsFollowing(tui) || tui.isFollowingOutput;
	const redraw = (id: string) => invalidators.get(id)?.();
	const flush = () => {
		if (!live || !following()) return;
		for (const id of tracker.flush()) redraw(id);
	};
	const restore = (ctx: ExtensionContext) => {
		live = ctx.mode === "tui";
		const { turns, errorIds } = turnsFromBranch(ctx.sessionManager.getBranch());
		tracker.restore(turns, errorIds);
		for (const id of invalidators.keys()) redraw(id);
	};

	pi.registerToolRenderer((toolName, next) =>
		wrapToolRenderers(toolName, next(), {
			isFolded: (id) => live && tracker.isFolded(id),
			remember: (id, invalidate) => invalidators.set(id, invalidate),
		}),
	);

	pi.on("session_start", (_event, ctx) => {
		invalidators.clear();
		restore(ctx);
		if (!live) return;
		// A below-editor widget adds no spacer; it only lends us the renderer to ask whether the
		// transcript is following its end.
		ctx.ui.setWidget(
			PROBE_WIDGET_KEY,
			(widgetTui) => {
				tui = widgetTui;
				return { render: () => [], invalidate() {} };
			},
			{ placement: "belowEditor" },
		);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("agent_start", () => {
		tracker.startTurn();
		flush();
	});
	pi.on("message_end", (event) => {
		const message = event.message;
		if ("role" in message && message.role === "assistant") {
			for (const content of message.content) if (content.type === "toolCall") tracker.noteCall(content.id);
		}
		flush();
	});
	pi.on("tool_execution_start", (event) => {
		if (!event.parentToolCallId) tracker.noteCall(event.toolCallId);
		flush();
	});
	pi.on("tool_execution_end", (event) => {
		if (!event.parentToolCallId && event.isError && tracker.noteError(event.toolCallId)) redraw(event.toolCallId);
		flush();
	});
	pi.on("session_shutdown", () => {
		live = false;
		tui = undefined;
		invalidators.clear();
	});

	return tracker;
}
