import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerCodexFastFeature } from "./codex-fast.ts";
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

type Rgb = readonly [red: number, green: number, blue: number];

type FooterPalette = {
	primary: Rgb;
	separator: Rgb;
	warning: Rgb;
	error: Rgb;
	thinking: Record<"low" | "medium" | "high" | "xhigh" | "max", Rgb>;
};

// Flexoki by Steph Ango (MIT): https://stephango.com/flexoki
const FLEXOKI_LIGHT: FooterPalette = {
	primary: [102, 128, 11], // green-600 · #66800B
	separator: [183, 181, 172], // base-300 · #B7B5AC
	warning: [173, 131, 1], // yellow-600 · #AD8301
	error: [175, 48, 41], // red-600 · #AF3029
	thinking: {
		low: [208, 162, 21], // yellow-400 · subtle on paper
		medium: [190, 146, 7], // yellow-500
		high: [173, 131, 1], // yellow-600
		xhigh: [142, 107, 1], // yellow-700
		max: [102, 77, 1], // yellow-800
	},
};

const FLEXOKI_DARK: FooterPalette = {
	primary: [135, 154, 57], // green-400 · #879A39
	separator: [87, 86, 83], // base-700 · #575653
	warning: [208, 162, 21], // yellow-400 · #D0A215
	error: [209, 77, 65], // red-400 · #D14D41
	thinking: {
		low: [142, 107, 1], // yellow-700
		medium: [173, 131, 1], // yellow-600
		high: [208, 162, 21], // yellow-400
		xhigh: [223, 180, 49], // yellow-300
		max: [236, 203, 96], // yellow-200
	},
};

const colorize = ([red, green, blue]: Rgb, text: string): string =>
	`\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;

function getFooterPalette(theme: Theme): FooterPalette {
	return theme.name?.toLowerCase().includes("light") ? FLEXOKI_LIGHT : FLEXOKI_DARK;
}

function styleThinkingLevel(theme: Theme, palette: FooterPalette, level: string): string {
	if (level === "off") return theme.fg("thinkingOff", level);
	if (level === "minimal") return theme.fg("dim", level);
	if (level in palette.thinking) {
		const styled = colorize(palette.thinking[level as keyof typeof palette.thinking], level);
		return level === "high" || level === "xhigh" || level === "max" ? theme.bold(styled) : styled;
	}
	return colorize(palette.primary, level);
}

export function registerFooterFeature(pi: ExtensionAPI): void {
	let footerInstalled = false;
	let thinkingLevel = "high";
	let requestFooterRender: (() => void) | undefined;
	const requestRender = () => requestFooterRender?.();
	const getCodexFast = registerCodexFastFeature(pi, requestRender);
	const getCodexUsage = registerCodexUsageFeature(pi, requestRender);

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
					const palette = getFooterPalette(theme);
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
						const value = `${pct.toFixed(1)}%`;
						contextPct = theme.fg("dim", "ctx ")
							+ (pct > 60 ? colorize(palette.error, value) : colorize(palette.primary, value));
					}

					const costStr = cost === 0
						? theme.fg("dim", "$0.00")
						: theme.fg("dim", "$") + colorize(palette.primary, cost.toFixed(2));
					const codexUsage = getCodexUsage();
					const colorizeCodexUsage = (used: number | undefined) => {
						const text = used === undefined ? "?%" : `${Math.round(used)}%`;
						if (used !== undefined && used > 90) return colorize(palette.error, text);
						if (used !== undefined && used > 70) return colorize(palette.warning, text);
						return colorize(palette.primary, text);
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
									? `${theme.fg("dim", "↺")}${colorize(palette.primary, String(codexUsage.availableResets))}`
									: "",
							].filter(Boolean).join(" ")
						: "";

					const modelStr = colorize(palette.primary, ctx.model?.id ?? "no-model");
					const levelStr = styleThinkingLevel(theme, palette, thinkingLevel);
					const fast = getCodexFast();
					const fastStr = fast.enabled && fast.eligible
						? colorize(palette.primary, "fast")
						: theme.fg("dim", "fast");
					const divider = " " + colorize(palette.separator, "•") + " ";
					const left = [modelStr, levelStr, fastStr].join(divider);
					const right = [costStr, contextPct, codexStr].filter(Boolean).join(divider);
					const rightWidth = visibleWidth(right);
					const minimumGap = right ? 2 : 0;
					const leftBudget = Math.max(0, width - rightWidth - minimumGap);

					if (leftBudget === 0) return [truncateToWidth(right, width)];

					let fittedLeft = left;
					if (visibleWidth(left) > leftBudget) {
						const suffix = levelStr + divider + fastStr;
						const suffixWidth = visibleWidth(suffix);
						const modelDividerWidth = visibleWidth(divider);
						if (leftBudget > suffixWidth + modelDividerWidth) {
							fittedLeft = truncateToWidth(modelStr, leftBudget - suffixWidth - modelDividerWidth)
								+ divider + suffix;
						} else if (leftBudget >= suffixWidth) {
							fittedLeft = suffix;
						} else {
							fittedLeft = truncateToWidth(fastStr, leftBudget);
						}
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
