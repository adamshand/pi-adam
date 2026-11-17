import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import type { TrackingOwner } from "./time-tracking-store.ts";

export type TrackingProcess = { state: "running"; startedAt: number } | { state: "missing" | "unknown" };

/** Query OS process birth, not Date.now()-uptime (which changes after clock corrections). */
export function inspectTrackingProcess(pid: number): TrackingProcess {
	const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
		encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
	});
	if (result.status === 0) {
		const startedAt = Date.parse(`${result.stdout.trim()} UTC`);
		if (Number.isFinite(startedAt)) return { state: "running", startedAt };
	}
	try { process.kill(pid, 0); }
	catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return { state: "missing" }; }
	return { state: "unknown" };
}

export function trackingOwnerAlive(owner: TrackingOwner, host = hostname(), inspect = inspectTrackingProcess): boolean {
	if (owner.host !== host) return false;
	const process = inspect(owner.pid);
	// Unknown is deliberately conservative: never take an unverifiable live owner's tracker.
	return process.state === "unknown" || (process.state === "running" && process.startedAt === owner.startedAt);
}

export function currentTrackingOwner(): TrackingOwner {
	const identity = inspectTrackingProcess(process.pid);
	if (identity.state !== "running") throw new Error("Cannot verify this Pi process's start time; tracking requires a working /bin/ps.");
	return { host: hostname(), pid: process.pid, startedAt: identity.startedAt };
}
