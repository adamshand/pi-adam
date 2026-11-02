import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerClaudeUsageFeature, snapshotFromRateLimitInfo } from "./claude-usage.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";

const future = Math.floor(Date.now() / 1000) + 3600;
const rateLimit = (fiveHour: number, weekly: number, resetAt = future) => ({
	status: "allowed",
	rateLimitType: "five_hour",
	unifiedWindows: {
		five_hour: { utilization: fiveHour, resetsAt: resetAt, status: "allowed" },
		seven_day: { utilization: weekly, resetsAt: future + 86400, status: "allowed" },
	},
});
const assistant = (details: ReturnType<typeof rateLimit>, timestamp = Date.now()) => ({
	role: "assistant",
	diagnostics: [{ type: "claude-code.turn-relay", timestamp }, { type: "claude-code.rate-limit", timestamp, details }],
});

test("snapshotFromRateLimitInfo converts utilization fractions to percentages", () => {
	assert.deepEqual(snapshotFromRateLimitInfo(rateLimit(0.5, 0.25)), {
		fiveHourUsed: 50,
		weeklyUsed: 25,
		fiveHourResetAt: future,
		weeklyResetAt: future + 86400,
	});
	assert.equal(snapshotFromRateLimitInfo({}), undefined);
});

test("Claude usage seeds from the branch and updates on message_end", async () => {
	type Handler = (event: { message: unknown }, ctx: ExtensionContext) => void;
	const handlers = new Map<string, Handler>();
	let changes = 0;
	const feature = registerClaudeUsageFeature(createTestExtensionApi({
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerCommand() {},
	}), () => { changes += 1; });
	const ctx = createTestExtensionContext({
		model: { provider: "claude-code" },
		sessionManager: { getBranch: () => [{ type: "message", message: assistant(rateLimit(0.1, 0.2), 1) }] },
	});

	handlers.get("session_start")?.({ message: undefined }, ctx);
	assert.equal(feature.getState().status, "ready");
	assert.equal(Math.round(feature.getState().snapshot?.fiveHourUsed ?? -1), 10);

	handlers.get("message_end")?.({ message: assistant(rateLimit(0.45, 0.57, Math.floor(Date.now() / 1000) - 1)) }, ctx);
	assert.equal(feature.getState().snapshot?.fiveHourUsed, 0, "expired windows read as empty");
	assert.equal(Math.round(feature.getState().snapshot?.weeklyUsed ?? -1), 57);

	handlers.get("message_end")?.({ message: { role: "assistant" } }, ctx);
	assert.equal(changes, 2);
});
