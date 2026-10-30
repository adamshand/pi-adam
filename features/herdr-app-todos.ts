import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { sessionTodoPath } from "../herdr/todos/work-item-store.js";

export const HERDR_TODOS_LABEL = "pi-adam.todos";
const TerminalSchema = Type.Object({ labels: Type.Record(Type.String(), Type.String()) });
type Environment = Readonly<Record<string, string | undefined>>;

/** Publish identity, not Todo content: the native panel reads the existing session file. */
export function registerHerdrAppTodosFeature(pi: ExtensionAPI, environment: Environment = process.env): void {
	const terminal = environment.HC_TERMINAL_ID;
	if (!terminal) return;

	let owner = "";
	let published: string | undefined;
	let pending = Promise.resolve();
	const enqueue = (operation: () => Promise<void>): Promise<void> => {
		pending = pending.then(operation).catch(() => undefined);
		return pending;
	};

	const publish = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" || !owner) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const value = JSON.stringify({
			version: 1, owner, session_id: sessionId, cwd: ctx.cwd,
			todo_path: sessionTodoPath(ctx.cwd, sessionId), name: pi.getSessionName() || "",
			ideas_reader: fileURLToPath(new URL("../herdr/app/ideas/read-ideas.js", import.meta.url)),
			node: process.execPath,
		});
		if (value === published) return;
		const result = await pi.exec("hc", ["label", terminal, `${HERDR_TODOS_LABEL}=${value}`], { timeout: 3000 });
		if (result.code === 0) published = value;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		owner = randomUUID();
		return enqueue(() => publish(ctx));
	});
	// Also retries a failed startup publication, without a polling process.
	pi.on("agent_start", (_event, ctx) => enqueue(() => publish(ctx)));
	pi.on("session_info_changed", (_event, ctx) => enqueue(() => publish(ctx)));

	pi.on("session_shutdown", () => enqueue(async () => {
		if (!published) return;
		const result = await pi.exec("hc", ["get", terminal], { timeout: 3000 });
		if (result.code !== 0) return;
		const current = Parse(TerminalSchema, JSON.parse(result.stdout));
		// An older/nested runtime must not erase a newer session's publication.
		if (current.labels[HERDR_TODOS_LABEL] === published) {
			await pi.exec("hc", ["label", terminal, `${HERDR_TODOS_LABEL}=`], { timeout: 3000 });
		}
		published = undefined;
		owner = "";
	}));
}
