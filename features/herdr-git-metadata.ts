import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Parse } from "typebox/value";

type HerdrEnvironment = Readonly<Record<string, string | undefined>>;

type GitMetadata = {
	branch?: string;
	gitStatus?: string;
};

type TimerId = ReturnType<typeof setInterval> | number | string;

type TimerOptions = {
	pollIntervalMs?: number;
	setInterval?: (handler: () => void, intervalMs: number) => TimerId;
	clearInterval?: (id: TimerId) => void;
};

type WorkingTreeChanges = {
	tracked: number;
	untracked: number;
};

const PaneListResponseSchema = Type.Object({
	result: Type.Optional(Type.Object({
		panes: Type.Optional(Type.Array(Type.Object({
			pane_id: Type.Optional(Type.String()),
			agent_session: Type.Optional(Type.Object({
				agent: Type.Optional(Type.String()),
				value: Type.Optional(Type.String()),
			})),
		}))),
	})),
});

const METADATA_SOURCE = "pi-adam.git";
const DEFAULT_POLL_INTERVAL_MS = 5000;

function sameMetadata(left: GitMetadata | undefined, right: GitMetadata): boolean {
	return left !== undefined && left.branch === right.branch && left.gitStatus === right.gitStatus;
}

function countWorkingTreeChanges(stdout: string): WorkingTreeChanges {
	let tracked = 0;
	let untracked = 0;
	const records = stdout.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.startsWith("? ")) untracked += 1;
		else if (record.startsWith("1 ") || record.startsWith("u ")) tracked += 1;
		else if (record.startsWith("2 ")) {
			tracked += 1;
			index += 1; // Rename/copy records are followed by their original path.
		}
	}
	return { tracked, untracked };
}

function formatGitStatus(
	workingTree: WorkingTreeChanges,
	upstreamStdout?: string,
): string | undefined {
	const upstream = upstreamStdout?.trim().match(/^(\d+)\s+(\d+)$/);
	const ahead = upstream ? Number(upstream[1]) : 0;
	const behind = upstream ? Number(upstream[2]) : 0;
	const parts = [
		workingTree.tracked > 0 ? `!${workingTree.tracked}` : "",
		workingTree.untracked > 0 ? `?${workingTree.untracked}` : "",
		ahead > 0 ? `↑${ahead}` : "",
		behind > 0 ? `↓${behind}` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

export function registerHerdrGitMetadataFeature(
	pi: ExtensionAPI,
	environment: HerdrEnvironment = process.env,
	timerOptions: TimerOptions = {},
): void {
	const initialPaneId = environment.HERDR_PANE_ID;
	if (environment.HERDR_ENV !== "1" || !initialPaneId) return;

	const pollIntervalMs = timerOptions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const startInterval = timerOptions.setInterval ?? ((handler, intervalMs) => setInterval(handler, intervalMs));
	const stopInterval = timerOptions.clearInterval ?? ((id) => clearInterval(id));
	let intervalId: TimerId | undefined;
	let active = false;
	let paneId = initialPaneId;
	let sessionFiles: string[] = [];
	let sessionId: string | undefined;
	let lastReported: GitMetadata | undefined;
	let requestedCwd: string | undefined;
	let running: Promise<void> | undefined;

	const readMetadata = async (cwd: string): Promise<GitMetadata> => {
		const branchResult = await pi.exec(
			"git",
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			{ cwd, timeout: 3000 },
		);
		const branch = branchResult.code === 0 ? branchResult.stdout.trim() || undefined : undefined;
		const workingTreeResult = await pi.exec(
			"git",
			["status", "--porcelain=v2", "-z", "--untracked-files=all", "--renames"],
			{ cwd, timeout: 3000 },
		);
		if (workingTreeResult.code !== 0) return {};
		const workingTree = countWorkingTreeChanges(workingTreeResult.stdout);

		const upstreamResult = branch
			? await pi.exec(
				"git",
				["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
				{ cwd, timeout: 3000 },
			)
			: undefined;
		return {
			branch,
			gitStatus: formatGitStatus(
				workingTree,
				upstreamResult?.code === 0 ? upstreamResult.stdout : undefined,
			),
		};
	};

	const metadataArgs = (targetPaneId: string, metadata: GitMetadata): string[] => {
		const args = ["pane", "report-metadata", targetPaneId, "--source", METADATA_SOURCE];
		if (metadata.branch) args.push("--token", `branch=${metadata.branch}`);
		else args.push("--clear-token", "branch");
		if (metadata.gitStatus) args.push("--token", `git_status=${metadata.gitStatus}`);
		else args.push("--clear-token", "git_status");
		return args;
	};

	const resolveMovedPaneId = async (): Promise<string | undefined> => {
		if (sessionFiles.length === 0 && !sessionId) return undefined;
		const result = await pi.exec("herdr", ["pane", "list"], { timeout: 5000 });
		if (result.code !== 0) return undefined;
		let response;
		try {
			response = Parse(PaneListResponseSchema, JSON.parse(result.stdout));
		} catch {
			return undefined;
		}
		return response.result?.panes?.find((pane) => {
			const agentSession = pane.agent_session;
			if (agentSession?.agent !== "pi" || !agentSession.value) return false;
			return sessionFiles.includes(agentSession.value)
				|| (sessionId !== undefined && agentSession.value.includes(sessionId));
		})?.pane_id;
	};

	const reportMetadata = async (metadata: GitMetadata): Promise<boolean> => {
		let result = await pi.exec("herdr", metadataArgs(paneId, metadata), { timeout: 5000 });
		if (result.code === 0) return true;

		const movedPaneId = await resolveMovedPaneId();
		if (!movedPaneId || movedPaneId === paneId) return false;
		paneId = movedPaneId;
		result = await pi.exec("herdr", metadataArgs(paneId, metadata), { timeout: 5000 });
		return result.code === 0;
	};

	const sync = async (cwd: string): Promise<void> => {
		let metadata: GitMetadata;
		try {
			metadata = await readMetadata(cwd);
		} catch {
			return;
		}
		if (sameMetadata(lastReported, metadata)) return;
		try {
			if (await reportMetadata(metadata)) lastReported = metadata;
		} catch {
			// Git metadata is optional; retry on the next lifecycle event or poll.
		}
	};

	const enqueueSync = (cwd: string): Promise<void> => {
		if (!active) return Promise.resolve();
		requestedCwd = cwd;
		if (!running) {
			running = (async () => {
				while (active && requestedCwd !== undefined) {
					const nextCwd = requestedCwd;
					requestedCwd = undefined;
					await sync(nextCwd);
				}
			})().finally(() => {
				running = undefined;
			});
		}
		return running;
	};

	pi.on("session_start", (event, ctx) => {
		active = true;
		paneId = initialPaneId;
		sessionFiles = [ctx.sessionManager.getSessionFile(), event.previousSessionFile]
			.filter((path): path is string => path !== undefined);
		sessionId = ctx.sessionManager.getSessionId();
		if (intervalId !== undefined) stopInterval(intervalId);
		if (pollIntervalMs > 0) {
			intervalId = startInterval(() => {
				void enqueueSync(ctx.cwd);
			}, pollIntervalMs);
		}
		return enqueueSync(ctx.cwd);
	});

	pi.on("before_agent_start", (_event, ctx) => enqueueSync(ctx.cwd));
	pi.on("agent_settled", (_event, ctx) => enqueueSync(ctx.cwd));

	pi.on("session_shutdown", async () => {
		active = false;
		requestedCwd = undefined;
		if (intervalId !== undefined) {
			stopInterval(intervalId);
			intervalId = undefined;
		}
		await running;
		try {
			await reportMetadata({});
		} catch {
			// Pane teardown must not block Pi shutdown when Herdr is unavailable.
		}
		lastReported = undefined;
	});
}
