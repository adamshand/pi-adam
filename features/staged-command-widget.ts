import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** A completed command is an inert transcript card, never another approval surface. */
export function commandResultCard(content: string, theme: Theme): Component {
	const text = new Text(content, 0, 0);
	const color = content.startsWith("[command completed · exit 0]") ? "success" : "error";
	return {
		render(width) {
			if (width < 1) return [];
			if (width < 6) return text.render(width).map(line => truncateToWidth(line, width));
			const innerWidth = width - 5;
			const border = (line: string) => theme.fg(color, line);
			return [
				border(`┌${"─".repeat(width - 2)}┐`),
				...["", ...text.render(innerWidth), ""].map(line => truncateToWidth(line, innerWidth)).map(line => `${border("│")}  ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} ${border("│")}`),
				border(`└${"─".repeat(width - 2)}┘`),
			];
		},
		invalidate() { text.invalidate(); },
	};
}

export type CommandAction = "run" | "copy" | "dismiss";
type ButtonHit = { action: CommandAction; x: number; y: number; width: number };
export type CommandCard = { title: string; location: string; command: string; isPreview?: boolean };

/** Non-focusable: typing and transcript scrolling stay with Pi. */
export class StagedCommandWidget implements Component {
	private hits: ButtonHit[] = [];
	private readonly card: CommandCard;
	private readonly theme: Theme;
	private readonly activate: (action: CommandAction) => void;
	private readonly maxCommandLines: () => number;
	private readonly showKeyboardHint: () => boolean;
	constructor(card: CommandCard, theme: Theme, activate: (action: CommandAction) => void, maxCommandLines: () => number = () => 6, showKeyboardHint: () => boolean = () => true) {
		this.card = card;
		this.theme = theme;
		this.activate = activate;
		this.maxCommandLines = maxCommandLines;
		this.showKeyboardHint = showKeyboardHint;
	}

	render(width: number): string[] {
		this.hits = [];
		if (width < 1) return [];
		if (width < 6) return this.renderContent(width);
		const content = this.renderContent(width - 5);
		this.hits = this.hits.map(hit => ({ ...hit, x: hit.x + 3, y: hit.y + 1 }));
		const border = (text: string) => this.theme.fg("dim", text);
		return [
			border(`┌${"─".repeat(width - 2)}┐`),
			...content.map(line => `${border("│")}  ${line}${" ".repeat(Math.max(0, width - 5 - visibleWidth(line)))} ${border("│")}`),
			border(`└${"─".repeat(width - 2)}┘`),
		];
	}

	private renderContent(width: number): string[] {
		const lines = [
			this.theme.fg("accent", truncateToWidth(`# ${this.card.title}`, width)),
			this.theme.fg("muted", truncateToWidth(this.card.location, width)),
			"",
		];
		if (this.card.isPreview) lines.push(this.theme.fg("dim", truncateToWidth("Command preview · SSH transport options omitted", width)));
		const commandLines = wrapTextWithAnsi(`$ ${this.card.command.replaceAll("\t", "    ")}`, width);
		const limit = Math.max(1, this.maxCommandLines());
		lines.push(...commandLines.slice(0, limit).map(line => this.theme.fg("toolOutput", line)));
		if (commandLines.length > limit) lines.push(this.theme.fg("warning", truncateToWidth("… full command in transcript; Copy preserves exact text", width)));
		lines.push("");
		let row = "";
		let x = 0;
		const buttons: { action: CommandAction; label: string }[] = [
			{ action: "run", label: "[ ▶ Run ]" },
			{ action: "copy", label: "[ Copy ]" },
			{ action: "dismiss", label: "[ Dismiss ]" },
		];
		for (const button of buttons) {
			const label = truncateToWidth(button.label, width);
			const size = visibleWidth(label);
			if (x > 0 && x + 2 + size > width) { lines.push(row); row = ""; x = 0; }
			if (x > 0) { row += "  "; x += 2; }
			this.hits.push({ action: button.action, x, y: lines.length, width: size });
			row += this.theme.fg(button.action === "run" ? "success" : "muted", label);
			x += size;
		}
		lines.push(row, this.theme.fg("muted", truncateToWidth("Run shares output with the agent", width)));
		if (this.showKeyboardHint()) lines.push(this.theme.fg("dim", truncateToWidth("/run executes · /dismiss cancels", width)));
		return lines;
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.button !== "left" || event.ctrl || event.alt || event.shift) return;
		const hit = this.hits.find(item => event.y === item.y && event.x >= item.x && event.x < item.x + item.width);
		if (!hit || (event.type !== "press" && event.type !== "click")) return;
		if (event.type === "click") this.activate(hit.action);
		return { handled: true, render: false };
	}

	invalidate(): void { this.hits = []; }
}
