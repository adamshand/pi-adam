import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { delimiter, resolve } from "node:path";
import { Type } from "typebox";
import { Check, Parse } from "typebox/value";

const PACKAGE_BIN = resolve(import.meta.dirname, "..", "node_modules", ".bin");
const SKILLS_DIR = resolve(import.meta.dirname, "..", "skills");
const COMMAND_TIMEOUT_MS = 5_000;
const MANAGED_ENVIRONMENT_NAMES = [
	"AGENT_BROWSER_SESSION",
	"AGENT_BROWSER_CONTENT_BOUNDARIES",
	"AGENT_BROWSER_MAX_OUTPUT",
	"AGENT_BROWSER_IDLE_TIMEOUT_MS",
	"PATH",
] as const;

type Environment = Record<string, string | undefined>;

const SessionListResponseSchema = Type.Object({
	data: Type.Optional(Type.Object({
		sessions: Type.Optional(Type.Array(Type.Unknown())),
	})),
});

export function parseActiveAgentBrowserSessions(stdout: string): string[] {
	try {
		const sessions = Parse(SessionListResponseSchema, JSON.parse(stdout)).data?.sessions ?? [];
		return sessions.filter((value): value is string => Check(Type.String(), value));
	} catch {
		return [];
	}
}

function prependPackageBin(environment: Environment): void {
	const entries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
	if (entries.includes(PACKAGE_BIN)) return;
	environment.PATH = [PACKAGE_BIN, ...entries].join(delimiter);
}

export function registerAgentBrowserFeature(
	pi: ExtensionAPI,
	environment: Environment = process.env,
): void {
	let sessionName: string | undefined;
	let originalEnvironment = new Map<string, string | undefined>();

	const restoreEnvironment = (): void => {
		for (const [name, value] of originalEnvironment) {
			if (value === undefined) delete environment[name];
			else environment[name] = value;
		}
		originalEnvironment = new Map();
	};

	pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIR] }));

	pi.on("session_start", (_event, ctx) => {
		restoreEnvironment();
		for (const name of MANAGED_ENVIRONMENT_NAMES) originalEnvironment.set(name, environment[name]);

		sessionName = `pi-${ctx.sessionManager.getSessionId()}`;
		environment.AGENT_BROWSER_SESSION = sessionName;
		environment.AGENT_BROWSER_CONTENT_BOUNDARIES ??= "1";
		environment.AGENT_BROWSER_MAX_OUTPUT ??= "12000";
		environment.AGENT_BROWSER_IDLE_TIMEOUT_MS ??= "900000";
		prependPackageBin(environment);
	});

	pi.on("session_shutdown", async (event) => {
		const closingSession = sessionName;
		try {
			if (event.reason === "reload" || !closingSession) return;

			const list = await pi.exec("agent-browser", ["session", "list", "--json"], {
				timeout: COMMAND_TIMEOUT_MS,
			});
			if (list.code !== 0 || !parseActiveAgentBrowserSessions(list.stdout).includes(closingSession)) {
				return;
			}
			await pi.exec("agent-browser", ["--session", closingSession, "close"], {
				timeout: COMMAND_TIMEOUT_MS,
			});
		} catch {
			// The idle timeout is the cleanup backstop if inspection or close fails.
		} finally {
			restoreEnvironment();
			sessionName = undefined;
		}
	});
}
