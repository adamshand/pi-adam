import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const TURN_STAMP_ENTRY_TYPE = "pi-adam-turn-stamp";

export type TurnStampData = {
	version: 1;
	completedAt: number;
};

const LOCAL_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
	weekday: "short",
	day: "numeric",
	month: "long",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
	hourCycle: "h12",
});

export function formatTurnStamp(completedAt: number): string | undefined {
	if (!Number.isFinite(completedAt)) return undefined;
	const date = new Date(completedAt);
	if (Number.isNaN(date.getTime())) return undefined;

	const parts = new Map(LOCAL_DATE_TIME.formatToParts(date).map((part) => [part.type, part.value]));
	const weekday = parts.get("weekday");
	const day = parts.get("day");
	const month = parts.get("month");
	const year = parts.get("year");
	const hour = parts.get("hour");
	const minute = parts.get("minute");
	const dayPeriod = parts.get("dayPeriod")?.toUpperCase();
	if (!weekday || !day || !month || !year || !hour || !minute || !dayPeriod) return undefined;

	return `${weekday} ${day} ${month} ${year}, ${hour}:${minute}${dayPeriod}`;
}

export function registerTurnStampFeature(
	pi: ExtensionAPI,
	now: () => number = Date.now,
): void {
	let tuiSessionActive = false;
	let hasPendingAssistantTurn = false;

	pi.registerEntryRenderer<TurnStampData>(TURN_STAMP_ENTRY_TYPE, (entry, _options, theme) => {
		const completedAt = entry.data?.completedAt;
		if (completedAt === undefined) return undefined;
		const label = formatTurnStamp(completedAt);
		if (!label) return undefined;
		return {
			render(width: number): string[] {
				if (width < 1) return [];
				const fitted = truncateToWidth(theme.fg("dim", label), width, "");
				const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
				return [padding + fitted];
			},
			invalidate() {},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		tuiSessionActive = ctx.mode === "tui";
		hasPendingAssistantTurn = false;
	});

	pi.on("turn_end", (event) => {
		if (tuiSessionActive && event.message.role === "assistant") {
			hasPendingAssistantTurn = true;
		}
	});

	pi.on("agent_settled", () => {
		if (!tuiSessionActive || !hasPendingAssistantTurn) return;
		hasPendingAssistantTurn = false;
		const completedAt = now();
		if (!formatTurnStamp(completedAt)) return;
		pi.appendEntry<TurnStampData>(TURN_STAMP_ENTRY_TYPE, {
			version: 1,
			completedAt,
		});
	});

	pi.on("session_shutdown", () => {
		tuiSessionActive = false;
		hasPendingAssistantTurn = false;
	});
}
