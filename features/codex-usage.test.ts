import assert from "node:assert/strict";
import test from "node:test";
import { snapshotFromRateLimit } from "./codex-usage.ts";

test("classifies the usual 5-hour and weekly windows by duration", () => {
	assert.deepEqual(
		snapshotFromRateLimit({
			primary_window: { used_percent: 12, reset_at: 100, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: 34, reset_at: 200, limit_window_seconds: 604_800 },
		}),
		{
			fiveHourUsed: 12,
			weeklyUsed: 34,
			fiveHourResetAt: 100,
			weeklyResetAt: 200,
		},
	);
});

test("classifies a weekly-only primary window as weekly", () => {
	assert.deepEqual(
		snapshotFromRateLimit({
			primary_window: { used_percent: 15, reset_at: 200, limit_window_seconds: 604_800 },
			secondary_window: null,
		}),
		{
			fiveHourUsed: undefined,
			weeklyUsed: 15,
			fiveHourResetAt: undefined,
			weeklyResetAt: 200,
		},
	);
});

test("falls back to the legacy positions when durations are absent", () => {
	assert.deepEqual(
		snapshotFromRateLimit({
			primary_window: { used_percent: 56, reset_at: 100 },
			secondary_window: { used_percent: 78, reset_at: 200 },
		}),
		{
			fiveHourUsed: 56,
			weeklyUsed: 78,
			fiveHourResetAt: 100,
			weeklyResetAt: 200,
		},
	);
});
