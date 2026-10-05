import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerCompactionFeature(pi: ExtensionAPI): void {
	let requested = false;
	const clear = () => { requested = false; };

	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	// Automatic or manual compaction can satisfy the request before settlement.
	pi.on("session_compact", clear);

	pi.on("context", (event, ctx) => {
		const percent = ctx.getContextUsage()?.percent;
		return {
			messages: [...event.messages, {
				role: "custom" as const,
				customType: "pi-adam-context-usage",
				content: percent == null
					? "Current context usage is unknown."
					: `Current context usage: ${percent.toFixed(1)}%.`,
				display: false,
				timestamp: Date.now(),
			}],
		};
	});

	pi.registerTool({
		name: "request_compaction",
		label: "Request compaction",
		description: "Request the session's existing compaction process after you finish your response. If you've finished a job and context usage is over 50%, consider whether now is a good time to compact. Prefer natural stopping points, especially before unrelated work; 50% is guidance, not a requirement. Compaction takes time, so avoid unnecessary requests. Returns immediately: deliver your final response normally, without polling. This does not change how context is compacted.",
		parameters: Type.Object({}),
		async execute() {
			requested = true;
			return {
				content: [{ type: "text", text: "Compaction requested for the end of this run. Finish your response normally; compaction has not started yet." }],
				details: undefined,
			};
		},
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!requested) return;
		if (event.outcome !== "completed") {
			clear();
			return;
		}
		if (ctx.hasPendingMessages()) return;
		clear();
		// compact() aborts and waits for idle. Never await it from a lifecycle
		// handler: let settlement finish so the existing compactor can proceed.
		ctx.compact({
			onError: (error) => {
				if (ctx.hasUI) ctx.ui.notify(`Requested compaction failed: ${error.message}`, "error");
			},
		});
	});
}
