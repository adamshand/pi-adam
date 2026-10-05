import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isCodexUsageEligible,
	registerCodexUsageFeature,
	snapshotFromRateLimit,
	type CodexUsageFeature,
} from "./codex-usage.ts";
import { createTestExtensionApi, createTestExtensionContext } from "./test-extension.ts";

type TestEvent = { type: string };
type EventHandler = (event: TestEvent, ctx: ExtensionContext) => void | Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => void | Promise<void>;
type RegisteredCommand = { handler: CommandHandler };

type UsageHarness = {
	ctx: ExtensionContext;
	feature: CodexUsageFeature;
	emit(name: string): Promise<void>;
	selectModel(next: Model<Api>): void;
};

function model(id = "gpt-5.6-sol", provider: Model<Api>["provider"] = "openai-codex"): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: "openai-codex-responses",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function jwt(): string {
	const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } };
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function createUsageHarness(selectedModel: Model<Api>, oauth = true, signal?: AbortSignal): UsageHarness {
	const handlers = new Map<string, EventHandler>();
	const commands = new Map<string, RegisteredCommand>();
	const contextStub = {
		mode: "tui" as const,
		model: selectedModel,
		signal,
		modelRegistry: {
			isUsingOAuth: () => oauth,
			getApiKeyForProvider: async () => jwt(),
		},
		ui: { notify() {} },
	};
	const ctx = createTestExtensionContext(contextStub);
	const pi = createTestExtensionApi({
		on(name: string, handler: EventHandler) { handlers.set(name, handler); },
		registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
	});
	const feature = registerCodexUsageFeature(pi, () => undefined);
	return {
		ctx,
		feature,
		async emit(name: string) {
			await handlers.get(name)?.({ type: name }, ctx);
		},
		selectModel(next: Model<Api>) {
			contextStub.model = next;
		},
	};
}

function successfulResponse(input: RequestInfo | URL): Response {
	const url = String(input);
	if (url.endsWith("rate-limit-reset-credits")) return Response.json({ available_count: 2 });
	return Response.json({
		rate_limit: {
			primary_window: { used_percent: 12, reset_at: 100, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: 34, reset_at: 200, limit_window_seconds: 604_800 },
		},
	});
}

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

test("limits polling to OAuth Codex models", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCount = 0;
	globalThis.fetch = async (input) => {
		fetchCount += 1;
		return successfulResponse(input);
	};
	try {
		const harness = createUsageHarness(model("gpt-5.6-sol", "openai"));
		assert.equal(isCodexUsageEligible(harness.ctx), false);
		await harness.emit("session_start");
		assert.equal(fetchCount, 0);
		assert.equal(harness.feature.getState().status, "ineligible");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("coalesces concurrent refreshes behind one in-flight request", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCount = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	globalThis.fetch = async (input) => {
		fetchCount += 1;
		await gate;
		return successfulResponse(input);
	};
	try {
		const harness = createUsageHarness(model());
		const start = harness.emit("session_start");
		await new Promise((resolve) => setImmediate(resolve));
		const refreshes = [harness.feature.refresh(harness.ctx), harness.feature.refresh(harness.ctx)];
		release?.();
		await Promise.all([start, ...refreshes]);
		assert.equal(fetchCount, 2, "concurrent refreshes issued a duplicate usage request pair");
		assert.equal(harness.feature.getState().status, "ready");
		await harness.emit("session_shutdown");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("keeps a successful snapshot but marks it stale after a failed refresh", async () => {
	const originalFetch = globalThis.fetch;
	let failing = false;
	globalThis.fetch = async (input) => failing ? new Response("failure", { status: 503 }) : successfulResponse(input);
	try {
		const harness = createUsageHarness(model());
		await harness.emit("session_start");
		failing = true;
		await harness.feature.refresh(harness.ctx, { force: true });
		const state = harness.feature.getState();
		assert.equal(state.status, "stale");
		assert.equal(state.snapshot?.weeklyUsed, 34);
		assert.match(state.lastError ?? "", /503/);
		await harness.emit("session_shutdown");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("clears account usage when the selected model becomes ineligible", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => successfulResponse(input);
	try {
		const harness = createUsageHarness(model());
		await harness.emit("session_start");
		assert.ok(harness.feature.getState().snapshot);
		harness.selectModel(model("other-model", "openai"));
		await harness.emit("model_select");
		assert.equal(harness.feature.getState().status, "ineligible");
		assert.equal(harness.feature.getState().snapshot, undefined);
		await harness.emit("session_shutdown");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("does not couple background usage refreshes to the current agent-turn signal", async () => {
	const originalFetch = globalThis.fetch;
	const turnAbort = new AbortController();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	globalThis.fetch = async (input) => {
		await gate;
		return successfulResponse(input);
	};
	try {
		const harness = createUsageHarness(model(), true, turnAbort.signal);
		const start = harness.emit("session_start");
		await new Promise((resolve) => setImmediate(resolve));
		turnAbort.abort(new Error("user stopped the agent turn"));
		release?.();
		await start;
		assert.equal(harness.feature.getState().status, "ready");
		await harness.emit("session_shutdown");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("reports an inactive lifecycle instead of remaining in loading state", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCount = 0;
	globalThis.fetch = async (input) => {
		fetchCount += 1;
		return successfulResponse(input);
	};
	try {
		const harness = createUsageHarness(model());
		await harness.feature.refresh(harness.ctx, { force: true });
		assert.equal(fetchCount, 0);
		assert.equal(harness.feature.getState().status, "error");
		assert.match(harness.feature.getState().lastError ?? "", /lifecycle is inactive/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("replaces an old session refresh without allowing stale results to commit", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCount = 0;
	globalThis.fetch = async (input, init) => {
		fetchCount += 1;
		if (fetchCount > 2) return successfulResponse(input);
		return new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		});
	};
	try {
		const harness = createUsageHarness(model());
		const firstStart = harness.emit("session_start");
		await new Promise((resolve) => setImmediate(resolve));
		const replacementStart = harness.emit("session_start");
		await Promise.all([firstStart, replacementStart]);
		assert.equal(fetchCount, 4);
		assert.equal(harness.feature.getState().status, "ready");
		assert.equal(harness.feature.getState().snapshot?.fiveHourUsed, 12);
		await harness.emit("session_shutdown");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("aborts an in-flight refresh during session shutdown", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
	});
	try {
		const harness = createUsageHarness(model());
		const start = harness.emit("session_start");
		await new Promise((resolve) => setImmediate(resolve));
		await harness.emit("session_shutdown");
		await start;
		assert.equal(harness.feature.getState().status, "idle");
		assert.equal(harness.feature.getState().lastError, undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
