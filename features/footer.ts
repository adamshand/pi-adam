import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerCodexUsageFeature } from "./codex-usage.ts";

type AssistantUsage = {
	cost?: { total?: number };
};

type MessageWithUsage = {
	usage?: AssistantUsage;
};

function getAssistantUsage(message: unknown): AssistantUsage | undefined {
	return (message as MessageWithUsage).usage;
}

const PRIMARY_VALUE_COLOR = "\x1b[38;2;36;131;123m"; // cyan-600 · #24837B
const SEPARATOR_COLOR = "\x1b[38;2;160;47;111m"; // magenta-600 · #A02F6F
const colorizePrimaryValue = (text: string): string => `${PRIMARY_VALUE_COLOR}${text}\x1b[39m`;
const colorizeSeparator = (text: string): string => `${SEPARATOR_COLOR}${text}\x1b[39m`;

export function registerFooterFeature(pi: ExtensionAPI): void {
	let footerInstalled = false;
	let thinkingLevel = "high";
	let requestFooterRender: (() => void) | undefined;
	const getCodexUsage = registerCodexUsageFeature(pi, () => requestFooterRender?.());

	pi.on("thinking_level_select", (event) => {
		thinkingLevel = event.level;
		requestFooterRender?.();
	});

	pi.on("model_select", () => {
		requestFooterRender?.();
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") requestFooterRender?.();
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
					let cost = 0;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							cost += getAssistantUsage(entry.message)?.cost?.total ?? 0;
						}
					}

					const contextUsage = ctx.getContextUsage();
					const ctxLimit = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const ctxTokens = contextUsage?.tokens ?? 0;
					let contextPct = "";
					if (ctxLimit > 0) {
						const pct = (ctxTokens / ctxLimit) * 100;
						contextPct = theme.fg("dim", "ctx ") + colorizePrimaryValue(`${pct.toFixed(1)}%`);
					}

					const costStr = theme.fg("dim", "$") + colorizePrimaryValue(cost.toFixed(2));
					const codexUsage = getCodexUsage();
					const colorizeCodexUsage = (used: number | undefined) => {
						const text = used === undefined ? "?%" : `${Math.round(used)}%`;
						return colorizePrimaryValue(text);
					};
					const codexStr = codexUsage
						? [
								codexUsage.fiveHourUsed !== undefined
									? `${theme.fg("dim", "5h ")}${colorizeCodexUsage(codexUsage.fiveHourUsed)}`
									: "",
								codexUsage.weeklyUsed !== undefined
									? `${theme.fg("dim", "wk ")}${colorizeCodexUsage(codexUsage.weeklyUsed)}`
									: "",
								codexUsage.availableResets !== undefined
									? `${theme.fg("dim", "↺")}${colorizePrimaryValue(String(codexUsage.availableResets))}`
									: "",
							].filter(Boolean).join(" ")
						: "";

					const modelStr = colorizePrimaryValue(ctx.model?.id ?? "no-model");
					const levelStr = colorizePrimaryValue(thinkingLevel);
					const divider = " " + colorizeSeparator("•") + " ";
					const left = [modelStr, levelStr].join(divider);
					const right = [costStr, contextPct, codexStr].filter(Boolean).join(divider);
					const rightWidth = visibleWidth(right);
					const minimumGap = right ? 2 : 0;
					const leftBudget = Math.max(0, width - rightWidth - minimumGap);

					if (leftBudget === 0) return [truncateToWidth(right, width)];

					let fittedLeft = left;
					if (visibleWidth(left) > leftBudget) {
						const fixedWidth = visibleWidth(divider) + visibleWidth(levelStr);
						fittedLeft = leftBudget > fixedWidth
							? truncateToWidth(modelStr, leftBudget - fixedWidth) + divider + levelStr
							: truncateToWidth(levelStr, leftBudget);
					}
					const pad = " ".repeat(Math.max(minimumGap, width - visibleWidth(fittedLeft) - rightWidth));
					return [truncateToWidth(fittedLeft + pad + right, width)];
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
