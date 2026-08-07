import assert from "node:assert/strict";
import test from "node:test";
import { registerHerdrGitMetadataFeature } from "./herdr-git-metadata.ts";

type Handler = (event: any, ctx?: any) => unknown;

type ExecCall = {
	command: string;
	args: string[];
	cwd?: string;
};

type GitState = {
	branch?: string;
	tracked?: number;
	untracked?: number;
	porcelain?: string;
	ahead?: number;
	behind?: number;
	hasUpstream?: boolean;
};

function createHarness(initialState: GitState = {}) {
	const handlers = new Map<string, Handler>();
	const calls: ExecCall[] = [];
	const clearedIntervals: unknown[] = [];
	let intervalHandler: (() => void) | undefined;
	let currentPaneId = "w1:p2";
	let state = { hasUpstream: true, ...initialState };
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		async exec(command: string, args: string[], options?: { cwd?: string }) {
			calls.push({ command, args, cwd: options?.cwd });
			if (command === "git" && args[0] === "symbolic-ref") {
				return state.branch
					? { code: 0, stdout: `${state.branch}\n`, stderr: "", killed: false }
					: { code: 1, stdout: "", stderr: "", killed: false };
			}
			if (command === "git" && args[0] === "status") {
				if (state.porcelain !== undefined) {
					return { code: 0, stdout: state.porcelain, stderr: "", killed: false };
				}
				const entries = [
					...Array.from({ length: state.tracked ?? 0 }, (_, index) => `1 M. N... 100644 100644 100644 abc def tracked-${index}`),
					...Array.from({ length: state.untracked ?? 0 }, (_, index) => `? untracked-${index}`),
				];
				return { code: 0, stdout: entries.length > 0 ? `${entries.join("\0")}\0` : "", stderr: "", killed: false };
			}
			if (command === "git" && args[0] === "rev-list") {
				return state.hasUpstream
					? { code: 0, stdout: `${state.ahead ?? 0}\t${state.behind ?? 0}\n`, stderr: "", killed: false }
					: { code: 128, stdout: "", stderr: "no upstream", killed: false };
			}
			if (command === "herdr" && args[0] === "pane" && args[1] === "report-metadata" && args[2] !== currentPaneId) {
				return { code: 1, stdout: '{"error":{"code":"pane_not_found"}}', stderr: "", killed: false };
			}
			if (command === "herdr" && args[0] === "pane" && args[1] === "list") {
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							panes: [{
								pane_id: currentPaneId,
								agent_session: { agent: "pi", value: "/sessions/session-123.jsonl" },
							}],
						},
					}),
					stderr: "",
					killed: false,
				};
			}
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	};

	registerHerdrGitMetadataFeature(
		pi as any,
		{ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
		{
			pollIntervalMs: 5000,
			setInterval(handler) {
				intervalHandler = handler;
				return "interval-1";
			},
			clearInterval(id) {
				clearedIntervals.push(id);
			},
		},
	);

	return {
		calls,
		clearedIntervals,
		handlers,
		poll: () => intervalHandler?.(),
		movePane(paneId: string) {
			currentPaneId = paneId;
		},
		setState(next: GitState) {
			state = { hasUpstream: true, ...next };
		},
	};
}

const context = {
	cwd: "/src/sites/bugs",
	sessionManager: {
		getSessionFile: () => "/sessions/session-123.jsonl",
		getSessionId: () => "session-123",
	},
};

test("reports working-tree and ahead/behind metadata for the current Pi pane", async () => {
	const { calls, handlers } = createHarness({
		branch: "feature/sidebar",
		tracked: 3,
		untracked: 2,
		ahead: 2,
		behind: 1,
	});
	await handlers.get("session_start")?.({ reason: "startup" }, context);

	assert.deepEqual(calls, [
		{
			command: "git",
			args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
			cwd: "/src/sites/bugs",
		},
		{
			command: "git",
			args: ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--renames"],
			cwd: "/src/sites/bugs",
		},
		{
			command: "git",
			args: ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
			cwd: "/src/sites/bugs",
		},
		{
			command: "herdr",
			args: [
				"pane",
				"report-metadata",
				"w1:p2",
				"--source",
				"pi-adam.git",
				"--token",
				"branch=feature/sidebar",
				"--token",
				"git_status=!3 ?2 ↑2 ↓1",
			],
			cwd: undefined,
		},
	]);
});

test("counts rename records once and still reports dirty state on a detached HEAD", async () => {
	const porcelain = [
		"2 R. N... 100644 100644 100644 abc def R100 renamed",
		"original",
		"u UU N... 100644 100644 100644 100644 abc def ghi conflicted",
		"? untracked",
		"",
	].join("\0");
	const { calls, handlers } = createHarness({ porcelain });
	await handlers.get("session_start")?.({ reason: "startup" }, context);

	assert.deepEqual(calls.at(-1)?.args.slice(-4), [
		"--clear-token",
		"branch",
		"--token",
		"git_status=!2 ?1",
	]);
});

test("clears unavailable values for detached, non-Git, and no-upstream checkouts", async () => {
	const { calls, handlers } = createHarness();
	await handlers.get("session_start")?.({ reason: "startup" }, context);

	assert.deepEqual(calls.at(-1), {
		command: "herdr",
		args: [
			"pane",
			"report-metadata",
			"w1:p2",
			"--source",
			"pi-adam.git",
			"--clear-token",
			"branch",
			"--clear-token",
			"git_status",
		],
		cwd: undefined,
	});

	const upstream = createHarness({ branch: "main", hasUpstream: false });
	await upstream.handlers.get("session_start")?.({ reason: "startup" }, context);
	assert.deepEqual(upstream.calls.at(-1)?.args.slice(-4), [
		"--token",
		"branch=main",
		"--clear-token",
		"git_status",
	]);
});

test("omits zero ahead/behind status and only reports changed metadata", async () => {
	const harness = createHarness({ branch: "main", ahead: 0, behind: 0 });
	await harness.handlers.get("session_start")?.({ reason: "startup" }, context);
	await harness.handlers.get("agent_settled")?.({}, context);

	assert.equal(harness.calls.filter(({ command }) => command === "herdr").length, 1);
	assert.deepEqual(harness.calls.find(({ command }) => command === "herdr")?.args.slice(-4), [
		"--token",
		"branch=main",
		"--clear-token",
		"git_status",
	]);

	harness.setState({ branch: "release", ahead: 3, behind: 0 });
	harness.poll();
	await harness.handlers.get("agent_settled")?.({}, context);
	assert.deepEqual(harness.calls.filter(({ command }) => command === "herdr").at(-1)?.args.slice(-4), [
		"--token",
		"branch=release",
		"--token",
		"git_status=↑3",
	]);
});

test("resolves a pane's new public ID after Herdr moves it", async () => {
	const harness = createHarness({ branch: "main" });
	await harness.handlers.get("session_start")?.({ reason: "startup" }, context);
	harness.movePane("w2:p7");
	harness.setState({ branch: "release" });
	await harness.handlers.get("agent_settled")?.({}, context);

	assert.equal(harness.calls.some(({ args }) => args.join(" ") === "pane list"), true);
	assert.deepEqual(harness.calls.filter(({ command, args }) => command === "herdr" && args[1] === "report-metadata").at(-1)?.args.slice(0, 3), [
		"pane",
		"report-metadata",
		"w2:p7",
	]);
});

test("uses the previous session path to recover a moved pane after session replacement", async () => {
	const harness = createHarness({ branch: "main" });
	await harness.handlers.get("session_start")?.({ reason: "startup" }, context);
	harness.movePane("w2:p7");
	await harness.handlers.get("session_shutdown")?.({ reason: "new" }, context);

	const replacementContext = {
		cwd: context.cwd,
		sessionManager: {
			getSessionFile: () => "/sessions/session-456.jsonl",
			getSessionId: () => "session-456",
		},
	};
	await harness.handlers.get("session_start")?.(
		{ reason: "new", previousSessionFile: "/sessions/session-123.jsonl" },
		replacementContext,
	);

	assert.deepEqual(harness.calls.filter(({ command, args }) => command === "herdr" && args[1] === "report-metadata").at(-1)?.args.slice(0, 3), [
		"pane",
		"report-metadata",
		"w2:p7",
	]);
});

test("stops polling and clears metadata when the Pi session shuts down", async () => {
	const { calls, clearedIntervals, handlers } = createHarness({ branch: "main" });
	await handlers.get("session_start")?.({ reason: "startup" }, context);
	await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
	assert.deepEqual(clearedIntervals, ["interval-1"]);
	assert.deepEqual(calls.filter(({ command }) => command === "herdr").at(-1)?.args.slice(-4), [
		"--clear-token",
		"branch",
		"--clear-token",
		"git_status",
	]);
});

test("is inert outside a Herdr pane", () => {
	const handlers = new Map<string, Handler>();
	registerHerdrGitMetadataFeature({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as any, { HERDR_ENV: "0" });
	assert.equal(handlers.size, 0);
});
