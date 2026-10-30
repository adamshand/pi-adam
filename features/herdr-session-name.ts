import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Parse } from "typebox/value";

type HerdrEnvironment = Readonly<Record<string, string | undefined>>;

type HerdrResult = {
	ok: boolean;
	stdout: string;
};

const CoreTerminalSchema = Type.Object({
	labels: Type.Record(Type.String(), Type.String()),
});

const TabGetResponseSchema = Type.Object({
	result: Type.Optional(Type.Object({
		tab: Type.Optional(Type.Object({ number: Type.Optional(Type.Number()) })),
	})),
});

function parseTabGetResponse(text: string) {
	try {
		return Parse(TabGetResponseSchema, JSON.parse(text));
	} catch {
		return undefined;
	}
}

export function registerHerdrSessionNameFeature(
	pi: ExtensionAPI,
	environment: HerdrEnvironment = process.env,
): void {
	const tabId = environment.HERDR_ENV === "1" ? environment.HERDR_TAB_ID : undefined;
	const terminal = environment.HC_TERMINAL_ID;
	if (!tabId && !terminal) return;

	const run = async (command: string, args: string[]): Promise<HerdrResult> => {
		try {
			const result = await pi.exec(command, args, { timeout: 5000 });
			return { ok: result.code === 0, stdout: result.stdout };
		} catch {
			return { ok: false, stdout: "" };
		}
	};

	const syncName = async (rawName: string | undefined): Promise<void> => {
		const name = rawName?.trim();
		if (!tabId) {
			// Resolve on each change: the terminal may have moved since Pi started.
			// A hidden/unlabelled terminal must never rename the focused tab instead.
			if (!terminal) return;
			const result = await run("hc", ["get", terminal]);
			if (!result.ok) return;
			let target: string | undefined;
			try { target = Parse(CoreTerminalSchema, JSON.parse(result.stdout)).labels["herdr.tab"]; }
			catch { return; }
			if (!target) return;
			const machine = terminal.includes("/") ? terminal.slice(0, terminal.indexOf("/")) : undefined;
			const id = machine ? `${machine}/${target}` : target;
			await run("herdr-app", ["do", "tab.rename", JSON.stringify({ id, name: name || "" })]);
			return;
		}
		if (name) {
			await run("herdr", ["tab", "rename", tabId, name]);
			return;
		}

		const tab = await run("herdr", ["tab", "get", tabId]);
		const tabNumber = tab.ok ? parseTabGetResponse(tab.stdout)?.result?.tab?.number : undefined;
		if (tabNumber !== undefined) await run("herdr", ["tab", "rename", tabId, String(tabNumber)]);
	};

	let pending = Promise.resolve();
	const enqueueSync = (name: string | undefined): Promise<void> => {
		const next = pending.then(() => syncName(name));
		pending = next.catch(() => undefined);
		return next;
	};

	pi.on("session_start", (event, ctx) => {
		if (!tabId && ctx.mode !== "tui") return;
		const name = pi.getSessionName();
		// Do not overwrite a manually named Herdr tab on initial startup. Session
		// replacement must clear metadata left by the previous Pi session.
		if (!name && (event.reason === "startup" || event.reason === "reload")) return;
		return enqueueSync(name);
	});

	pi.on("session_info_changed", (event, ctx) => {
		if (!tabId && ctx.mode !== "tui") return;
		return enqueueSync(event.name);
	});
}
