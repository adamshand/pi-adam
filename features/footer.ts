import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type AssistantUsage = {
	input?: number;
	output?: number;
	reasoningTokens?: number;
	cost?: { total?: number };
};

type MessageWithUsage = {
	usage?: AssistantUsage;
};

function getAssistantUsage(message: unknown): AssistantUsage | undefined {
	return (message as MessageWithUsage).usage;
}

function formatCompactNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

export function registerFooterFeature(pi: ExtensionAPI): void {
	let footerInstalled = false;
	let thinkingLevel = "high";
	let lastSpeed: number | null = null;
	let assistantStartTime: number | null = null;
	let requestFooterRender: (() => void) | undefined;

	pi.on("thinking_level_select", (event) => {
		thinkingLevel = event.level;
		requestFooterRender?.();
	});

	pi.on("model_select", () => {
		requestFooterRender?.();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") assistantStartTime = Date.now();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;

		const usage = getAssistantUsage(event.message);
		const outputTokens = usage?.output ?? 0;
		const elapsed = assistantStartTime ? (Date.now() - assistantStartTime) / 1000 : 0;

		// Skip if elapsed is unreasonably small, e.g. restored from session.
		if (elapsed > 0.5 && outputTokens > 0) lastSpeed = Math.round(outputTokens / elapsed);
		assistantStartTime = null;
		requestFooterRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		thinkingLevel = pi.getThinkingLevel();
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubBranch();
					requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					let input = 0,
						output = 0,
						cost = 0,
						reasoning = 0;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const usage = getAssistantUsage(entry.message);
							input += usage?.input ?? 0;
							output += usage?.output ?? 0;
							cost += usage?.cost?.total ?? 0;
							reasoning += usage?.reasoningTokens ?? 0;
						}
					}

					const sep = " " + theme.fg("dim", "│") + " ";
					const contextUsage = ctx.getContextUsage();
					const ctxLimit = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const ctxTokens = contextUsage?.tokens ?? 0;
					let contextPct = "";
					if (ctxLimit > 0) {
						const pct = (ctxTokens / ctxLimit) * 100;
						const color = pct > 80 ? "error" : pct > 50 ? "warning" : "success";
						contextPct = theme.fg(color, `${pct.toFixed(1)}%`) + theme.fg("dim", `/${formatCompactNumber(ctxLimit)}`);
					}

					const arrowUp = theme.fg("success", "↑") + theme.fg("text", formatCompactNumber(input));
					const arrowDown = theme.fg("error", "↓") + theme.fg("text", formatCompactNumber(output));
					const reasoningStr = reasoning > 0 ? theme.fg("accent", "R") + theme.fg("text", formatCompactNumber(reasoning)) : "";
					const costStr = theme.fg("warning", `$${cost.toFixed(3)}`);
					const speedStr = lastSpeed !== null ? theme.fg("mdLink", `${formatCompactNumber(lastSpeed)} t/s`) : "";

					const levelColors: Record<string, Parameters<typeof theme.fg>[0]> = {
						off: "thinkingOff",
						minimal: "thinkingMinimal",
						low: "thinkingLow",
						medium: "thinkingMedium",
						high: "thinkingHigh",
						"extra-high": "thinkingXhigh",
					};
					const levelDot = theme.fg(levelColors[thinkingLevel] ?? "accent", "●");
					const modelStr = theme.fg("accent", ctx.model?.id ?? "no-model");
					const levelStr = theme.fg("muted", thinkingLevel);
					const branch = footerData.getGitBranch();
					const gitStr = branch ? theme.fg("toolDiffAdded", ` ${branch}`) : "";

					const left = [arrowUp, arrowDown, reasoningStr, costStr, contextPct, speedStr].filter(Boolean).join(sep);
					const right = [modelStr, `${levelDot} ${levelStr}`, gitStr]
						.filter(Boolean)
						.join(" " + theme.fg("dim", "•") + " ");
					const leftContent = left + (right ? " " + theme.fg("dim", "│") + " " : "");
					const pad = " ".repeat(Math.max(1, width - visibleWidth(leftContent) - visibleWidth(right)));

					return [truncateToWidth(leftContent + pad + right, width)];
				},
			};
		});
		footerInstalled = true;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (footerInstalled && ctx.mode === "tui") ctx.ui.setFooter(undefined);
		footerInstalled = false;
		requestFooterRender = undefined;
	});
}
