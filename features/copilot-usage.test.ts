import assert from "node:assert/strict";
import test from "node:test";
import { isCopilotModel, snapshotFromCopilotUser } from "./copilot-usage.ts";

const reset = "2026-12-01T00:00:00.000Z";

test("premium-request usage uses GitHub's precomputed percentage and reports counts", () => {
	assert.deepEqual(snapshotFromCopilotUser({
		copilot_plan: "individual_pro",
		quota_reset_date_utc: reset,
		quota_snapshots: { premium_interactions: { unlimited: false, entitlement: 7000, remaining: 6401, quota_remaining: 6401.7, percent_remaining: 91.4, overage_count: 0 } },
	}), { monthUsed: 100 - 91.4, monthResetAt: Date.parse(reset) / 1000, premiumUsed: 598, premiumEntitlement: 7000, premiumOverage: undefined });
});

test("tolerates string numbers, missing percentages and overage", () => {
	const snapshot = snapshotFromCopilotUser({
		quota_reset_date: "2026-12-01",
		quota_snapshots: { premium_interactions: { entitlement: "300", remaining: "60", overage_count: 12 } },
	});
	assert.equal(snapshot?.monthUsed, 80);
	assert.equal(snapshot?.premiumUsed, 240);
	assert.equal(snapshot?.premiumOverage, 12);
	assert.equal(snapshot?.monthResetAt, Date.parse("2026-12-01") / 1000);
});

test("unlimited, zero-allowance and missing quotas show no percentage", () => {
	for (const premium of [{ unlimited: true, entitlement: 0 }, { entitlement: 0, remaining: 0, percent_remaining: 0 }, undefined]) {
		const snapshot = snapshotFromCopilotUser({ quota_reset_date_utc: reset, quota_snapshots: { premium_interactions: premium } });
		assert.deepEqual(snapshot, { monthResetAt: Date.parse(reset) / 1000 });
	}
	assert.equal(snapshotFromCopilotUser({}), undefined);
});

test("percent used is clamped to 0-100", () => {
	const over = snapshotFromCopilotUser({ quota_snapshots: { premium_interactions: { entitlement: 300, percent_remaining: -10 } } });
	assert.equal(over?.monthUsed, 100);
});

test("only the github-copilot provider is eligible", () => {
	// SAFETY: isCopilotModel only reads `provider`; the rest of Model is irrelevant here.
	assert.equal(isCopilotModel({ provider: "github-copilot" } as never), true);
	// SAFETY: as above.
	assert.equal(isCopilotModel({ provider: "openai-codex" } as never), false);
	assert.equal(isCopilotModel(undefined), false);
});
