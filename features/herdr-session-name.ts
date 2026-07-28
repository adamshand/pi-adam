import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type HerdrEnvironment = Readonly<Record<string, string | undefined>>;

type HerdrResult = {
	ok: boolean;
	stdout: string;
};

type WorkspaceGetResponse = {
	result?: { workspace?: { label?: string } };
};

type TabGetResponse = {
	result?: { tab?: { number?: number } };
};

const METADATA_SOURCE = "pi-adam.session-name";
const PI_AGENT_SOURCE = "herdr:pi";

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function registerHerdrSessionNameFeature(
	pi: ExtensionAPI,
	environment: HerdrEnvironment = process.env,
): void {
	const paneId = environment.HERDR_PANE_ID;
	const tabId = environment.HERDR_TAB_ID;
	const workspaceId = environment.HERDR_WORKSPACE_ID;
	if (environment.HERDR_ENV !== "1" || !paneId || !tabId || !workspaceId) return;

	const runHerdr = async (args: string[]): Promise<HerdrResult> => {
		try {
			const result = await pi.exec("herdr", args, { timeout: 5000 });
			return { ok: result.code === 0, stdout: result.stdout };
		} catch {
			return { ok: false, stdout: "" };
		}
	};

	const reportName = async (name: string, workspaceLabel: string): Promise<void> => {
		await runHerdr([
			"pane", "report-metadata", paneId,
			"--source", METADATA_SOURCE,
			"--agent", "pi",
			"--applies-to-source", PI_AGENT_SOURCE,
			"--title", name,
			"--display-agent", workspaceLabel,
		]);
	};

	const clearName = async (): Promise<void> => {
		await runHerdr([
			"pane", "report-metadata", paneId,
			"--source", METADATA_SOURCE,
			"--agent", "pi",
			"--applies-to-source", PI_AGENT_SOURCE,
			"--clear-title",
			"--clear-display-agent",
		]);
	};

	const syncName = async (rawName: string | undefined, cwd: string): Promise<void> => {
		const name = rawName?.trim();
		if (name) {
			const workspace = await runHerdr(["workspace", "get", workspaceId]);
			const workspaceLabel = workspace.ok
				? parseJson<WorkspaceGetResponse>(workspace.stdout)?.result?.workspace?.label?.trim()
				: undefined;
			await runHerdr(["tab", "rename", tabId, name]);
			await reportName(name, workspaceLabel || basename(cwd));
			return;
		}

		const tab = await runHerdr(["tab", "get", tabId]);
		const tabNumber = tab.ok ? parseJson<TabGetResponse>(tab.stdout)?.result?.tab?.number : undefined;
		if (tabNumber !== undefined) await runHerdr(["tab", "rename", tabId, String(tabNumber)]);
		await clearName();
	};

	let pending = Promise.resolve();
	const enqueueSync = (name: string | undefined, cwd: string): Promise<void> => {
		const next = pending.then(() => syncName(name, cwd));
		pending = next.catch(() => undefined);
		return next;
	};

	pi.on("session_start", (event, ctx) => {
		const name = pi.getSessionName();
		// Do not overwrite a manually named Herdr tab on initial startup. Session
		// replacement must clear metadata left by the previous Pi session.
		if (!name && (event.reason === "startup" || event.reason === "reload")) return;
		return enqueueSync(name, ctx.cwd);
	});

	pi.on("session_info_changed", (event, ctx) => enqueueSync(event.name, ctx.cwd));
}
