import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import type { FooterGitStats } from "./footer-git.ts";
import type { FooterAction, FooterControlEndpoint } from "./herdr-app-footer-controls.ts";

export const HERDR_FOOTER_LABEL = "pi-adam.footer";
export const HERDR_FOOTER_HOST_LABEL = "pi-adam.footer-host";
const TerminalSchema = Type.Object({ labels: Type.Record(Type.String(), Type.String()) });

/** Deliberately nonsecret display data only; no transcript, credentials, or raw errors. */
export type HerdrFooterMetrics = {
	model: string;
	thinking: string;
	fast: "on" | "off" | null;
	cost: number;
	contextTokens: number;
	contextWindow: number;
	speed?: number;
	git?: FooterGitStats;
	usage?: { status: string; fiveHourUsed?: number; weeklyUsed?: number; availableResets?: number };
	controls?: FooterControlEndpoint & { idle: boolean; actions: FooterAction[] };
};

/** Serial, deduplicated core publications; failures leave the terminal footer available. */
export class HerdrFooterBridge {
	private terminal: string | undefined;
	private owner = randomUUID();
	private published: string | undefined;
	private pending = Promise.resolve();
	private stopped = false;
	private attached = false;
	private pi: ExtensionAPI;
	private onChange: () => void;

	constructor(
		pi: ExtensionAPI,
		onChange: () => void,
		environment: Readonly<Record<string, string | undefined>> = process.env,
	) {
		this.pi = pi;
		this.onChange = onChange;
		this.terminal = environment.HC_TERMINAL_ID;
	}

	get active(): boolean { return this.attached; }

	private setActive(value: boolean): void {
		if (this.attached === value) return;
		this.attached = value;
		this.onChange();
	}

	publish(session: string, metrics: HerdrFooterMetrics): Promise<void> {
		if (!this.terminal || this.stopped) return Promise.resolve();
		const terminal = this.terminal;
		const value = JSON.stringify({ version: 1, owner: this.owner, session_id: session, ...metrics });
		this.pending = this.pending.then(async () => {
			if (this.stopped) return;
			// HC alone also exists outside the app. Require the new app's explicit tab label.
			const result = await this.pi.exec("hc", ["get", terminal], { timeout: 3000 });
			if (result.code !== 0) throw new Error("Core unavailable");
			const current = Parse(TerminalSchema, JSON.parse(result.stdout));
			if (!current.labels["herdr.tab"]) {
				this.setActive(false);
				return;
			}
			if (value !== this.published) {
				const write = await this.pi.exec("hc", ["label", terminal, `${HERDR_FOOTER_LABEL}=${value}`], { timeout: 3000 });
				if (write.code !== 0) throw new Error("Publication failed");
				this.published = value;
			}
			if (current.labels[HERDR_FOOTER_HOST_LABEL] === this.owner) {
				this.setActive(true);
				return;
			}
			this.setActive(false);
			// Only the installed native mod can acknowledge this runtime. Allow its live
			// label subscription a short bounded startup window; no permanent polling.
			for (const wait of [50, 100, 150]) {
				if (this.stopped) return;
				await delay(wait);
				const ack = await this.pi.exec("hc", ["get", terminal], { timeout: 3000 });
				if (ack.code !== 0) return;
				if (Parse(TerminalSchema, JSON.parse(ack.stdout)).labels[HERDR_FOOTER_HOST_LABEL] === this.owner) {
					this.setActive(true);
					return;
				}
			}
		}).catch(() => { this.setActive(false); });
		return this.pending;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await this.pending;
		const terminal = this.terminal;
		try {
			if (!terminal || !this.published) return;
			const result = await this.pi.exec("hc", ["get", terminal], { timeout: 3000 });
			if (result.code !== 0) return;
			const current = Parse(TerminalSchema, JSON.parse(result.stdout));
			if (current.labels[HERDR_FOOTER_LABEL] === this.published) {
				await this.pi.exec("hc", ["label", terminal, `${HERDR_FOOTER_LABEL}=`], { timeout: 3000 });
			}
		} catch {
			// Best effort; an older runtime must never erase a newer owner's metrics.
		} finally {
			this.published = undefined;
			this.setActive(false);
		}
	}
}
