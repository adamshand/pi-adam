import { spawnSync } from "node:child_process";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandResultCard, foldedResultLine, resultSucceeded, StagedCommandWidget, type CommandAction } from "./staged-command-widget.ts";
import { Type, type Static } from "typebox";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { captureInvocation, createCapture, readCapture } from "./staged-command-output.ts";

const Parameters = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 160 }),
	script: Type.String({ minLength: 1, maxLength: 16000, description: "Literal source code for the selected interpreter, preserving newlines and indentation. Do not shell-quote it or wrap it in ssh, sudo or python -c; use target, root and interpreter instead. Stage one coherent, reviewable operation." }),
	target: Type.Optional(Type.String({ description: "Exact SSH destination (user@host or SSH alias). Omit for local execution." })),
	interpreter: Type.Optional(Type.Union([Type.Literal("sh"), Type.Literal("bash"), Type.Literal("python3")])),
	root: Type.Optional(Type.Boolean({ description: "Execute interpreter using sudo as root." })),
	cwd: Type.Optional(Type.String({ description: "Absolute working directory. Local default: project directory; remote default: SSH login directory." })),
});
export type CommandDraft = Static<typeof Parameters>;
export type StagedCommand = Readonly<CommandDraft & { id: string; interpreter: "sh" | "bash" | "python3" }>;

// Reject terminal escape sequences rather than rendering untrusted control bytes.
// eslint-disable-next-line no-control-regex
const unsafeDisplay = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u;
export function prepareCommand(draft: CommandDraft, id: string, projectCwd: string): StagedCommand {
	if (!draft.title.trim() || !draft.script.trim()) throw new Error("Title and script must not be empty.");
	if (draft.title.length > 160 || Buffer.byteLength(draft.script) > 16000) throw new Error("Command is too large (16KB script maximum).");
	for (const value of [draft.title, draft.script, draft.cwd, draft.target]) {
		if (value && unsafeDisplay.test(value)) throw new Error("Control characters and bidirectional display overrides are not allowed.");
	}
	if (/[\n\t]/u.test(draft.title)) throw new Error("Title must be one line.");
	if (draft.target !== undefined && !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(draft.target)) {
		throw new Error("Use a plain SSH alias or user@host; options, ports, paths and IPv6 are not supported.");
	}
	const cwd = draft.cwd ?? (draft.target ? undefined : projectCwd);
	if (cwd !== undefined && (!cwd.startsWith("/") || /[\n\t]/u.test(cwd) || unsafeDisplay.test(cwd))) throw new Error("Working directory must be an absolute single-line path.");
	return Object.freeze({ ...draft, id, cwd, interpreter: draft.interpreter ?? "sh" });
}

export function quoteShell(value: string): string {
	return /^[a-zA-Z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** No temporary script to swap after review. */
export function commandInvocation(command: StagedCommand) {
	const interpreter = command.interpreter === "python3" ? "python3" : `/bin/${command.interpreter}`;
	const words = command.root ? ["sudo", "-k", "--", interpreter, "-c", command.script] : [interpreter, "-c", command.script];
	const execute = words.map(quoteShell).join(" ");
	if (command.target) {
		// SSH already invokes the remote login shell. Only wrap when we need a
		// POSIX shell to change directory before invoking the selected interpreter.
		const remote = command.cwd
			? `/bin/sh -c ${quoteShell(`cd ${quoteShell(command.cwd)} && exec ${execute}`)}`
			: execute;
		return { file: "ssh", args: ["-t", "-o", "StrictHostKeyChecking=yes", "--", command.target, remote], cwd: undefined };
	}
	return { file: words[0], args: words.slice(1), cwd: command.cwd };
}

export function commandMetadata(command: StagedCommand): string {
	return `${command.target ? `SSH: ${command.target}` : "Local"} · Run as: ${command.root ? "root (sudo)" : command.target ? "SSH login user" : "current user"} · Interpreter: ${command.interpreter}`;
}

export function commandReview(command: StagedCommand): string {
	return `${command.title}\n${commandMetadata(command)}\nDirectory: ${command.cwd ?? "SSH login directory"}\n\nScript:\n${command.script}`;
}

export function commandLine(command: StagedCommand): string {
	const invocation = commandInvocation(command);
	return [invocation.file, ...invocation.args].map(quoteShell).join(" ");
}

/** Human-readable preview omits SSH transport flags; execution and Copy retain them. */
export function commandPreview(command: StagedCommand): string {
	if (!command.target) return commandLine(command);
	const invocation = commandInvocation(command);
	return [invocation.file, ...invocation.args.slice(4)].map(quoteShell).join(" ");
}

export function copiedCommand(command: StagedCommand): string {
	const prefix = !command.target && command.cwd ? `cd ${quoteShell(command.cwd)} && ` : "";
	return `${prefix}${commandLine(command)}`;
}

async function runInTerminal(ctx: ExtensionContext, command: StagedCommand): Promise<string> {
	const outputPath = createCapture();
	const invocation = captureInvocation(commandInvocation(command), outputPath);
	return ctx.ui.custom<string>((tui, _theme, _keys, done) => {
		let status: string;
		let output: string;
		tui.stop();
		try {
			process.stdout.write(`\x1b[2J\x1b[H${commandReview(command)}\n\n`);
			const result = spawnSync(invocation.file, invocation.args, { stdio: "inherit", cwd: invocation.cwd });
			status = result.error ? `[command failed to launch: ${result.error.message}]`
				: result.signal ? `[command interrupted · ${result.signal}; child/remote execution may still be running]`
					: `[command ${result.status === 0 ? "completed" : "failed"} · exit ${result.status ?? "unknown"}]${command.target && result.status !== 0 ? "\nRemote changes may already have occurred; do not retry blindly." : ""}`;
			try { output = readCapture(outputPath); }
			catch { output = `(Could not read captured output: ${outputPath}. Do not rerun blindly.)`; }
			process.stdout.write(`\n${status}\n`);
		} finally {
			tui.start();
			tui.requestRender(true);
		}
		done(`${status}\n${commandReview(command)}\n\nOutput:\n${output}`);
		return { render: () => [], invalidate() {} };
	});
}

export function registerStagedCommandsFeature(pi: ExtensionAPI): void {
	// Like tool calls, a result folds to one line once the human has sent a later message.
	// Failures stay open; Ctrl+O expands. Checked at render time so folding applies live.
	let lastUserAt = 0;
	pi.registerMessageRenderer("staged-command-status", (message, options, theme) => {
		const content = Array.isArray(message.content) ? message.content.filter(block => block.type === "text").map(block => block.text).join("\n") : message.content;
		const card = commandResultCard(content, theme);
		const line = " ".repeat(options.outputPad) + foldedResultLine(content, theme);
		const folded = () => !options.expanded && resultSucceeded(content) && lastUserAt > message.timestamp;
		return {
			render: width => folded() ? [truncateToWidth(line, Math.max(1, width), "…")] : card.render(width),
			invalidate: () => card.invalidate(),
		};
	});
	const noteUser = (message: { role?: string; timestamp?: number }) => {
		if (message.role === "user" && message.timestamp !== undefined) lastUserAt = Math.max(lastUserAt, message.timestamp);
	};
	pi.on("message_start", event => noteUser(event.message));
	pi.on("session_start", (_event, ctx) => {
		lastUserAt = 0;
		for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "message") noteUser(entry.message);
	});
	pi.on("session_tree", (_event, ctx) => {
		lastUserAt = 0;
		for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "message") noteUser(entry.message);
	});
	let pending: StagedCommand | undefined;
	let sequence = 0;
	let running = false;
	let autoReviewPending = false;
	let activeReview: { command: StagedCommand; close: () => void } | undefined;
	const closeReview = () => {
		activeReview?.close();
		activeReview = undefined;
	};
	const clear = () => {
		pending = undefined;
		autoReviewPending = false;
		closeReview();
	};
	pi.on("session_start", () => clear());
	pi.on("session_shutdown", () => clear());
	pi.on("agent_start", () => closeReview());
	pi.registerShortcut("alt+r", {
		description: "Focus staged-command approval (Enter runs, Esc dismisses)",
		handler: async ctx => showReview(ctx),
	});
	async function showReview(ctx: ExtensionContext, automatic = false): Promise<void> {
		if (ctx.mode !== "tui" || !ctx.isIdle() || running || !pending || activeReview) return;
		autoReviewPending = false;
		const readyAt = performance.now() + (automatic ? 500 : 0);
		const command = pending;
		const review = { command, close: () => {} };
		activeReview = review;
		let action: CommandAction | undefined;
		try {
			action = await ctx.ui.custom<CommandAction | undefined>((_tui, theme, _keys, done) => {
				review.close = () => done(undefined);
				const widget = new StagedCommandWidget({ title: command.title, location: "", command: command.script }, theme, done, () => true, () => done(undefined), () => performance.now() >= readyAt);
				widget.focused = true;
				return widget;
			}, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "90%" } });
		} finally {
			if (activeReview === review) activeReview = undefined;
		}
		if (action) await act(action, command, ctx);
	}
	pi.on("agent_settled", (_event, ctx) => {
		if (!pending || !autoReviewPending || ctx.mode !== "tui" || running) return;
		autoReviewPending = false;
		if (ctx.ui.getEditorText().length > 0) {
			ctx.ui.notify("Command ready for review. Alt+R opens approval when you're ready.", "info");
			return;
		}
		// Never await human input from a settlement hook: notifications must finish.
		void showReview(ctx, true).catch(error => {
			ctx.ui.notify(error instanceof Error ? error.message : "Command review failed.", "error");
		});
	});

	async function run(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") { ctx.ui.notify("/run requires Pi's interactive terminal.", "warning"); return; }
		if (!ctx.isIdle()) { ctx.ui.notify("Wait until the agent finishes before running the staged command.", "warning"); return; }
		if (running) return;
		const command = pending;
		if (!command) { ctx.ui.notify("No staged command.", "info"); return; }
		clear();
		running = true;
		try {
			const result = await runInTerminal(ctx, command);
			pi.sendMessage({ customType: "staged-command-status", content: result, display: true }, { triggerTurn: true });
		} finally { running = false; }
	}

	async function act(action: CommandAction, command: StagedCommand, ctx: ExtensionContext): Promise<void> {
		// Bind clicks to the visible revision, never a subsequently staged replacement.
		if (pending !== command) { ctx.ui.notify("That staged command is no longer pending.", "warning"); return; }
		if (action === "run") await run(ctx);
		else if (action === "dismiss") clear();
		else {
			await copyToClipboard(copiedCommand(command));
			ctx.ui.notify("Copied command including working directory. Still pending.", "info");
		}
	}

	pi.registerTool({
		name: "stage_command",
		label: "Stage command for human",
		description: "Stage a single local or SSH command. A focused approval popup opens after the agent settles unless the user is drafting a message. Enter executes, Esc dismisses, Tab returns to chat; Alt+R reopens approval. /run and /dismiss also work. Staging again replaces the previous command. NEVER executes or grants access. Use for one coherent human-reviewed operation, interactive sudo, or a query not covered by inspection tools. Prefer sshro_* for supported read-only inspection; use ssh_exec only with an explicit human unrestricted grant. Never seek a broad grant just to avoid approvals, or silently work around protected reads. Pass literal source in script; use target/root/interpreter/cwd rather than embedding SSH, sudo or interpreter wrappers. Transport quoting is handled for you. The human reviews the source and execution metadata; Copy includes the runnable transport command. Exact multiline scripts are preserved. Command completion automatically shares captured terminal output with the agent and resumes it without another keypress. Do not include secrets: scripts appear in the transcript and process arguments, and output is recorded to a private local file. Cleared on reload or session change. Finish your response after staging; do not poll or run it yourself.",
		parameters: Parameters,
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", args.title || "Stage command"), 0, 0);
		},
		renderResult(result) {
			return new Text(result.content.filter(block => block.type === "text").map(block => block.text).join("\n").replaceAll("\t", "    "), 0, 0);
		},
		outputSchema: Type.Object({ id: Type.String(), status: Type.Literal("pending") }),
		async execute(_id, args, _signal, _update, ctx) {
			if (running) throw new Error("A human-approved command is still running.");
			const command = prepareCommand(args, `CMD-${++sequence}`, ctx.cwd);
			const replaced = pending !== undefined;
			pending = command;
			autoReviewPending = true;
			// Open only after settlement, never during the agent's turn.
			closeReview();
			const result = { id: command.id, status: "pending" as const };
			const text = `${replaced ? "Replaced staged command" : "Staged command"} · ${commandReview(command)}\n\nApproval opens when the agent finishes · Enter runs · Esc dismisses · Alt+R reopens`;
			return { content: [{ type: "text", text }], details: result, structuredContent: result };
		},
	});

	pi.registerCommand("dismiss", {
		description: "Discard the staged command",
		async handler(_args, ctx) {
			const hadCommand = pending !== undefined;
			clear();
			ctx.ui.notify(hadCommand ? "Staged command dismissed." : "No staged command.", "info");
		},
	});

	pi.registerCommand("run", {
		description: "Approve and execute the single staged command",
		async handler(args, ctx) {
			if (args.trim()) { ctx.ui.notify("Use /run without arguments.", "warning"); return; }
			await run(ctx);
		},
	});
}
