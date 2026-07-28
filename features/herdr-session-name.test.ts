import assert from "node:assert/strict";
import test from "node:test";
import { registerHerdrSessionNameFeature } from "./herdr-session-name.ts";

type Handler = (event: any, ctx?: any) => unknown;

type ExecCall = {
	command: string;
	args: string[];
};

function createHarness(sessionName?: string) {
	const handlers = new Map<string, Handler>();
	const calls: ExecCall[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		getSessionName() {
			return sessionName;
		},
		async exec(command: string, args: string[]) {
			calls.push({ command, args });
			if (args[0] === "workspace" && args[1] === "get") {
				return {
					code: 0,
					stdout: JSON.stringify({ result: { workspace: { label: "haume-made.git" } } }),
					stderr: "",
				};
			}
			if (args[0] === "tab" && args[1] === "get") {
				return {
					code: 0,
					stdout: JSON.stringify({ result: { tab: { number: 3 } } }),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};

	registerHerdrSessionNameFeature(pi as any, {
		HERDR_ENV: "1",
		HERDR_PANE_ID: "w1:p2",
		HERDR_TAB_ID: "w1:t3",
		HERDR_WORKSPACE_ID: "w1",
	});

	return { calls, handlers };
}

test("a Pi /name renames the Herdr tab and becomes the primary agent title", async () => {
	const { calls, handlers } = createHarness();
	await handlers.get("session_info_changed")?.({ name: "bugs" }, { cwd: "/src/haume-made.git" });

	assert.deepEqual(calls, [
		{ command: "herdr", args: ["workspace", "get", "w1"] },
		{ command: "herdr", args: ["tab", "rename", "w1:t3", "bugs"] },
		{
			command: "herdr",
			args: [
				"pane", "report-metadata", "w1:p2",
				"--source", "pi-adam.session-name",
				"--agent", "pi",
				"--applies-to-source", "herdr:pi",
				"--title", "bugs",
				"--display-agent", "haume-made.git",
			],
		},
	]);
});

test("clearing /name restores the numeric tab label and clears agent metadata", async () => {
	const { calls, handlers } = createHarness();
	await handlers.get("session_info_changed")?.({ name: undefined }, { cwd: "/src/haume-made.git" });

	assert.deepEqual(calls, [
		{ command: "herdr", args: ["tab", "get", "w1:t3"] },
		{ command: "herdr", args: ["tab", "rename", "w1:t3", "3"] },
		{
			command: "herdr",
			args: [
				"pane", "report-metadata", "w1:p2",
				"--source", "pi-adam.session-name",
				"--agent", "pi",
				"--applies-to-source", "herdr:pi",
				"--clear-title",
				"--clear-display-agent",
			],
		},
	]);
});

test("a named session is synchronized when Pi starts or resumes it", async () => {
	const { calls, handlers } = createHarness("release");
	await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/src/haume-made.git" });

	assert.equal(calls.some(({ args }) => args.join(" ") === "tab rename w1:t3 release"), true);
	assert.equal(calls.some(({ args }) => args.includes("--title") && args.includes("release")), true);
});

test("an unnamed initial session leaves manual Herdr labels alone", async () => {
	const { calls, handlers } = createHarness();
	await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/src/haume-made.git" });
	assert.deepEqual(calls, []);
});

test("the feature is inert outside a Herdr pane", () => {
	const handlers = new Map<string, Handler>();
	registerHerdrSessionNameFeature({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as any, { HERDR_ENV: "0" });
	assert.equal(handlers.size, 0);
});
