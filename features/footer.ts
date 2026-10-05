import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isCodexModel, registerCodexFastFeature } from "./codex-fast.ts";
import { isCodexImageModel } from "./codex-image.ts";
import { registerCodexUsageFeature } from "./codex-usage.ts";
import { centeredFooter, readFooterGitStats, type FooterGitStats } from "./footer-git.ts";

type Rgb = readonly [red: number, green: number, blue: number];
type ContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;

type FooterPalette = {
	primary: Rgb;
	separator: Rgb;
	warning: Rgb;
	error: Rgb;
	thinking: Record<"low" | "medium" | "high" | "xhigh" | "max", Rgb>;
};

type FooterMetrics = {
	cost: number;
	contextUsage: ContextUsage;
	costUpdatedAt?: number;
	contextUpdatedAt?: number;
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

function isPaletteThinkingLevel(level: string): level is keyof FooterPalette["thinking"] {
	return level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max";
}

function styleThinkingLevel(theme: Theme, palette: FooterPalette, level: string): string {
	if (level === "off") return theme.fg("thinkingOff", level);
	if (level === "minimal") return theme.fg("dim", level);
	if (isPaletteThinkingLevel(level)) {
		const styled = colorize(palette.thinking[level], level);
		return level === "high" || level === "xhigh" || level === "max" ? theme.bold(styled) : styled;
	}
	return colorize(palette.primary, level);
}

function branchCost(ctx: ExtensionContext): number {
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") cost += entry.message.usage.cost.total;
	}
	return cost;
}

function formatTimestamp(value: number | undefined): string {
	return value ? new Date(value).toLocaleTimeString() : "never";
}

export function registerFooterFeature(pi: ExtensionAPI): void {
	let footerInstalled = false;
	let gitStats: FooterGitStats | undefined;
	let gitRevision = 0;
	const refreshGit = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const revision = ++gitRevision;
		let next: FooterGitStats | undefined;
		try {
			next = await readFooterGitStats(pi, ctx.cwd);
		} catch {
			// Git may be unavailable; never retain stale counts on failure.
		}
		if (revision !== gitRevision) return;
		gitStats = next;
		requestFooterRender?.();
	};
	let thinkingLevel = "high";
	let lastSpeed: number | undefined;
	let assistantStartTime: number | undefined;
	let requestFooterRender: (() => void) | undefined;
	let metrics: FooterMetrics = { cost: 0, contextUsage: undefined };
	const requestRender = () => requestFooterRender?.();
	const getCodexFast = registerCodexFastFeature(pi, requestRender);
	const codexUsage = registerCodexUsageFeature(pi, requestRender);

	const refreshCost = (ctx: ExtensionContext) => {
		metrics = { ...metrics, cost: branchCost(ctx), costUpdatedAt: Date.now() };
	};
	const refreshContext = (ctx: ExtensionContext) => {
		metrics = { ...metrics, contextUsage: ctx.getContextUsage(), contextUpdatedAt: Date.now() };
	};
	const refreshMetrics = (ctx: ExtensionContext) => {
		refreshCost(ctx);
		refreshContext(ctx);
	};

	pi.registerCommand("pi-adam-status", {
		description: "Show pi-adam model, Fast, usage, image, and footer diagnostics",
		handler: async (_args, ctx) => {
			refreshMetrics(ctx);
			const fast = getCodexFast();
			const usage = codexUsage.getState();
			const context = metrics.contextUsage;
			const contextLimit = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const contextTokens = context?.tokens ?? 0;
			const contextPercent = contextLimit > 0 ? `${((contextTokens / contextLimit) * 100).toFixed(1)}%` : "unavailable";
			ctx.ui.notify([
				`Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
				`Thinking: ${thinkingLevel}`,
				`Fast: ${fast.enabled ? "requested" : "off"} · ${fast.eligible ? "eligible" : "ineligible"}`,
				`Fast last injection: ${formatTimestamp(fast.lastInjectedAt)}${fast.lastInjectedModel ? ` · ${fast.lastInjectedModel}` : ""}`,
				`Usage: ${usage.status} · last attempt ${formatTimestamp(usage.lastAttemptAt)} · last success ${formatTimestamp(usage.lastSuccessAt)}`,
				`Usage error: ${usage.lastError ?? "none"}`,
				`Image tool: ${isCodexImageModel(ctx.model) ? "eligible" : "ineligible"}`,
				`Footer cost: $${metrics.cost.toFixed(2)} · refreshed ${formatTimestamp(metrics.costUpdatedAt)}`,
				`Context: ${contextTokens}/${contextLimit || "?"} (${contextPercent}) · refreshed ${formatTimestamp(metrics.contextUpdatedAt)}`,
			].join("\n"), "info");
		},
	});

	pi.on("thinking_level_select", (event) => {
		thinkingLevel = event.level;
		requestFooterRender?.();
	});

	pi.on("model_select", (_event, ctx) => {
		refreshContext(ctx);
		requestFooterRender?.();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") assistantStartTime = Date.now();
	});

	pi.on("message_end", (event, ctx) => {
		refreshContext(ctx);
		if (event.message.role === "assistant") {
			const elapsedSeconds = assistantStartTime ? (Date.now() - assistantStartTime) / 1000 : 0;
			if (elapsedSeconds > 0.5 && event.message.usage.output > 0) {
				lastSpeed = Math.round(event.message.usage.output / elapsedSeconds);
			}
			assistantStartTime = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("turn_end", (event, ctx) => {
		void refreshGit(ctx);
		refreshContext(ctx);
		if (event.message.role === "assistant") {
			metrics = {
				...metrics,
				cost: metrics.cost + event.message.usage.cost.total,
				costUpdatedAt: Date.now(),
			};
		}
		requestFooterRender?.();
	});

	pi.on("agent_settled", (_event, ctx) => {
		void refreshGit(ctx);
		refreshContext(ctx);
		requestFooterRender?.();
	});

	pi.on("session_compact", (_event, ctx) => {
		refreshMetrics(ctx);
		requestFooterRender?.();
	});

	pi.on("session_tree", (_event, ctx) => {
		refreshMetrics(ctx);
		requestFooterRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		thinkingLevel = pi.getThinkingLevel();
		lastSpeed = undefined;
		assistantStartTime = undefined;
		if (ctx.mode !== "tui") return;
		refreshMetrics(ctx);
		gitStats = undefined;
		void refreshGit(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => {
				gitStats = undefined;
				void refreshGit(ctx);
				tui.requestRender();
			});

			return {
				dispose() {
					unsubBranch();
					requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const palette = getFooterPalette(theme);
					const contextUsage = metrics.contextUsage;
					const ctxLimit = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const ctxTokens = contextUsage?.tokens ?? 0;
					let contextPct = "";
					if (ctxLimit > 0) {
						const pct = (ctxTokens / ctxLimit) * 100;
						const value = `${pct.toFixed(1)}%`;
						contextPct = theme.fg("dim", "ctx ")
							+ (pct > 60 ? colorize(palette.error, value) : colorize(palette.primary, value));
					}

					const speedStr = lastSpeed === undefined
						? ""
						: colorize(palette.primary, String(lastSpeed)) + theme.fg("dim", " t/s");
					const costStr = metrics.cost === 0
						? theme.fg("dim", "$0.00")
						: theme.fg("dim", "$") + colorize(palette.primary, metrics.cost.toFixed(2));
					const showCodex = isCodexModel(ctx.model);
					const usage = codexUsage.getState();
					const colorizeCodexUsage = (used: number | undefined) => {
						const text = used === undefined ? "?%" : `${Math.round(used)}%`;
						if (used !== undefined && used > 90) return colorize(palette.error, text);
						if (used !== undefined && used > 70) return colorize(palette.warning, text);
						return colorize(palette.primary, text);
					};
					const usageHealth = usage.status === "error"
						? colorize(palette.error, "!")
						: usage.status === "stale"
							? colorize(palette.warning, "~")
							: usage.status === "loading"
								? theme.fg("dim", "…")
								: "";
					const codexStr = showCodex && usage.eligible && usage.snapshot
						? [
							usage.snapshot.fiveHourUsed !== undefined
								? `${theme.fg("dim", "5h ")}${colorizeCodexUsage(usage.snapshot.fiveHourUsed)}`
								: "",
							usage.snapshot.weeklyUsed !== undefined
								? `${theme.fg("dim", "wk ")}${colorizeCodexUsage(usage.snapshot.weeklyUsed)}`
								: "",
							usage.snapshot.availableResets !== undefined
								? `${theme.fg("dim", "↺")}${colorize(palette.primary, String(usage.snapshot.availableResets))}`
								: "",
							usageHealth,
						].filter(Boolean).join(" ")
						: showCodex && usageHealth ? `${theme.fg("dim", "usage ")}${usageHealth}` : "";

					const modelStr = colorize(palette.primary, ctx.model?.id ?? "no-model");
					const levelStr = styleThinkingLevel(theme, palette, thinkingLevel);
					const fast = getCodexFast();
					const fastStr = showCodex
						? fast.enabled && fast.eligible
							? colorize(palette.error, "fast")
							: theme.fg("dim", "fast")
						: undefined;
					const divider = " " + colorize(palette.separator, "•") + " ";
					const left = [modelStr, levelStr, fastStr].filter((part): part is string => part !== undefined).join(divider);
					const right = [speedStr, costStr, contextPct, codexStr].filter(Boolean).join(divider);
					const git = gitStats;
					const center = git ? [
						git.added ? colorize(palette.primary, `+${git.added}`) : "",
						git.removed ? colorize(palette.error, `−${git.removed}`) : "",
						git.ahead ? colorize(palette.primary, `↑${git.ahead}`) : "",
						git.behind ? colorize(palette.warning, `↓${git.behind}`) : "",
					].filter(Boolean).join(" ") : "";
					const centered = centeredFooter(width, left, center, right);
					if (centered !== undefined) return [centered];
					const rightWidth = visibleWidth(right);
					const minimumGap = right ? 2 : 0;
					const leftBudget = Math.max(0, width - rightWidth - minimumGap);

					if (leftBudget === 0) return [truncateToWidth(right, width)];

					let fittedLeft = left;
					if (visibleWidth(left) > leftBudget) {
						const suffix = fastStr ? levelStr + divider + fastStr : levelStr;
						const suffixWidth = visibleWidth(suffix);
						const modelDividerWidth = visibleWidth(divider);
						if (leftBudget > suffixWidth + modelDividerWidth) {
							fittedLeft = truncateToWidth(modelStr, leftBudget - suffixWidth - modelDividerWidth)
								+ divider + suffix;
						} else if (leftBudget >= suffixWidth) {
							fittedLeft = suffix;
						} else {
							fittedLeft = truncateToWidth(fastStr ?? levelStr, leftBudget);
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
		gitRevision += 1;
		gitStats = undefined;
		lastSpeed = undefined;
		assistantStartTime = undefined;
		requestFooterRender = undefined;
		metrics = { cost: 0, contextUsage: undefined };
	});
}
