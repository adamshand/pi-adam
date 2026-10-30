import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const RequestSchema = Type.Object({
	owner: Type.String(), session: Type.String(),
	action: Type.Union([Type.Literal("model"), Type.Literal("thinking"), Type.Literal("fast")]),
}, { additionalProperties: false });
export type FooterAction = Static<typeof RequestSchema>["action"];
export type FooterControlEndpoint = { socket: string; owner: string; session: string; client: string; node: string };
export type FooterControlResult = { ok: true } | { ok: false; error: string };

export function footerModelRotation(ctx: ExtensionContext) {
	const available = ctx.modelRegistry.getAvailable();
	if (!ctx.scopedModels.length) return available.map(model => ({ model, thinkingLevel: undefined }));
	return ctx.scopedModels.filter(scoped => available.some(model => model.provider === scoped.model.provider && model.id === scoped.model.id));
}

/** Session-scoped changes only. No terminal keystrokes, chat, or global defaults. */
export async function applyFooterAction(
	action: FooterAction, pi: ExtensionAPI, ctx: ExtensionContext,
	toggleFast: (ctx: ExtensionContext) => void,
): Promise<FooterControlResult> {
	if (ctx.mode !== "tui" || !ctx.isIdle() || ctx.hasPendingMessages()) return { ok: false, error: "Pi is busy. Try again when it is idle." };
	if (action === "model") {
		const models = footerModelRotation(ctx);
		if (models.length < 2) return { ok: false, error: "Only one model is available in this rotation." };
		const current = models.findIndex(({ model }) => model.provider === ctx.model?.provider && model.id === ctx.model?.id);
		const next = models[(current + 1) % models.length];
		if (!await pi.setModel(next.model)) return { ok: false, error: "The next model is unavailable. Check Pi authentication." };
		if (next.thinkingLevel !== undefined) pi.setThinkingLevel(next.thinkingLevel);
	} else if (action === "thinking") {
		const levels = ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
		if (levels.length < 2) return { ok: false, error: "This model has no alternate thinking levels." };
		pi.setThinkingLevel(levels[(levels.indexOf(pi.getThinkingLevel()) + 1) % levels.length]);
	} else {
		toggleFast(ctx);
	}
	return { ok: true };
}

/** Private per-runtime Unix socket; the native mod executes a small client on the same machine. */
export class FooterControlServer {
	private server: Server | undefined;
	private directory: string | undefined;
	private sockets = new Set<Socket>();
	private stopped = false;
	private handling = false;
	private inFlight: Promise<void> | undefined;

	async start(session: string, handle: (action: FooterAction) => Promise<FooterControlResult>): Promise<FooterControlEndpoint | undefined> {
		// Windows named pipes have different permissions. Do not expose an unprotected endpoint.
		if (process.platform === "win32") return undefined;
		this.directory = await mkdtemp(join(tmpdir(), "pif-"));
		await chmod(this.directory, 0o700);
		const socketPath = join(this.directory, "s");
		const owner = randomUUID();
		const server = createServer(socket => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => socket.destroy());
			socket.setTimeout(5000, () => socket.destroy());
			let input = "";
			let received = false;
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				if (received) return;
				input += chunk;
				if (input.length > 2048) { socket.destroy(); return; }
				if (!input.includes("\n")) return;
				received = true;
				const reply = (result: FooterControlResult) => { socket.end(`${JSON.stringify(result)}\n`); };
				let request: unknown;
				try { request = JSON.parse(input.trim()); } catch { reply({ ok: false, error: "Invalid footer request." }); return; }
				if (!Check(RequestSchema, request) || request.owner !== owner || request.session !== session || this.stopped) {
					reply({ ok: false, error: "This Pi session has changed. Wait for the footer to refresh." });
					return;
				}
				if (this.handling) { reply({ ok: false, error: "A footer change is already in progress." }); return; }
				this.handling = true;
				this.inFlight = (async () => {
					try { reply(await handle(request.action)); }
					catch { reply({ ok: false, error: "Pi could not apply the change. Check the session and try again." }); }
					finally { this.handling = false; }
				})();
			});
		});
		this.server = server;
		server.maxConnections = 8;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
			});
			server.on("error", () => { /* Existing sessions continue if the control listener fails. */ });
			await chmod(socketPath, 0o600);
			server.unref();
			return { socket: socketPath, owner, session, node: process.execPath,
				client: fileURLToPath(new URL("../herdr/app/status/control-client.js", import.meta.url)) };
		} catch {
			await this.stop();
			return undefined;
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const socket of this.sockets) socket.destroy();
		const server = this.server;
		this.server = undefined;
		if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
		await this.inFlight;
		if (this.directory) await rm(this.directory, { recursive: true, force: true });
		this.directory = undefined;
	}
}
