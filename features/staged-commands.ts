import { spawnSync } from "node:child_process";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandResultCard, StagedCommandWidget, type CommandAction } from "./staged-command-widget.ts";
import { Type, type Static } from "typebox";
import { captureInvocation, createCapture, readCapture } from "./staged-command-output.ts";

const Parameters = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 160 }),
	script: Type.String({ minLength: 1, maxLength: 16000 }),
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

function heading(command: StagedCommand): string {
	return `${command.title} · ${command.target ?? "local"}\nDirectory: ${command.cwd ?? "SSH login directory"}`;
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
			process.stdout.write(`\x1b[2J\x1b[H${heading(command)}\n\n${command.target ? "Command preview (SSH transport options omitted)\n" : ""}$ ${commandPreview(command)}\n\n`);
			const result = spawnSync(invocation.file, invocation.args, { stdio: "inherit", cwd: invocation.cwd });
			status = result.error ? `[command failed to launch: ${result.error.message}]`
				: result.signal ? `[command interrupted · ${result.signal}; child/remote execution may still be running]`
					: `[command ${result.status === 0 ? "completed" : "failed"} · exit ${result.status ?? "unknown"}]${command.target && result.status !== 0 ? "\nRemote changes may already have occurred; do not retry blindly." : ""}`;
			try { output = readCapture(outputPath); }
			catch { output = `(Could not read captured output: ${outputPath}. Do not rerun blindly.)`; }
			process.stdout.write(`\n${status}\n`);
			spawnSync("/bin/sh", ["-c", "printf '\\nPress Enter to return to Pi… '; IFS= read -r reply"], { stdio: "inherit" });
		} finally {
			tui.start();
			tui.requestRender(true);
		}
		done(`${status}\n${command.target ? "Command preview (SSH transport options omitted)\n" : ""}$ ${commandPreview(command)}\n\n${output}`);
		return { render: () => [], invalidate() {} };
	});
}

export function registerStagedCommandsFeature(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("staged-command-status", (message, _options, theme) => commandResultCard(
		Array.isArray(message.content) ? message.content.filter(block => block.type === "text").map(block => block.text).join("\n") : message.content, theme,
	));
	let pending: StagedCommand | undefined;
	let sequence = 0;
	let running = false;
	const widgetKey = "pi-adam-staged-command";
	const clear = (ctx: ExtensionContext) => {
		pending = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget(widgetKey, undefined);
	};
	pi.on("session_start", (_event, ctx) => clear(ctx));
	pi.on("session_shutdown", (_event, ctx) => clear(ctx));
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWidget(widgetKey, undefined);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (pending && !running) showWidget(pending, ctx);
	});

	async function run(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") { ctx.ui.notify("/run requires Pi's interactive terminal.", "warning"); return; }
		if (!ctx.isIdle()) { ctx.ui.notify("Wait until the agent finishes before running the staged command.", "warning"); return; }
		if (running) return;
		const command = pending;
		if (!command) { ctx.ui.notify("No staged command.", "info"); return; }
		clear(ctx);
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
		else if (action === "dismiss") clear(ctx);
		else {
			await copyToClipboard(copiedCommand(command));
			ctx.ui.notify("Copied command including working directory. Still pending.", "info");
		}
	}

	function showWidget(command: StagedCommand, ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(widgetKey, (tui, theme) => new StagedCommandWidget({
			title: command.title,
			location: command.cwd ?? "SSH login directory",
			command: commandPreview(command),
			isPreview: Boolean(command.target),
		}, theme, action => {
			// Finish mouse dispatch before removing widgets or handing over the terminal.
			setImmediate(() => { void act(action, command, ctx).catch(error => {
				ctx.ui.notify(error instanceof Error ? error.message : "Command action failed.", "error");
			}); });
		}, () => Math.max(1, Math.min(6, Math.floor(tui.terminal.rows / 3) - 8)), () => tui.mode !== "fullscreen"), { placement: "aboveEditor" });
	}

	pi.registerTool({
		name: "stage_command",
		label: "Stage command for human",
		description: "Stage a single local or SSH command. The user executes it with /run or cancels with /dismiss. Staging again replaces the previous command. NEVER executes or grants access. Use for human-controlled root/production access. Exact multiline scripts are preserved. Run shares captured terminal output with the agent and resumes it. Do not include secrets: scripts appear in the transcript and process arguments, and output is recorded to a private local file. Cleared on reload or session change. Finish your response after staging; do not poll or run it yourself.",
		parameters: Parameters,
		outputSchema: Type.Object({ id: Type.String(), status: Type.Literal("pending") }),
		async execute(_id, args, _signal, _update, ctx) {
			if (running) throw new Error("A human-approved command is still running.");
			const command = prepareCommand(args, `CMD-${++sequence}`, ctx.cwd);
			const replaced = pending !== undefined;
			pending = command;
			// Keep the card hidden until agent_settled, when approval can actually run.
			if (ctx.mode === "tui") ctx.ui.setWidget(widgetKey, undefined);
			const result = { id: command.id, status: "pending" as const };
			const text = `${replaced ? "Replaced staged command" : "Staged command"} · ${heading(command)}\n\n${command.target ? "Command preview (SSH transport options omitted)\n" : ""}$ ${commandPreview(command)}\n\n/run executes · /dismiss cancels`;
			return { content: [{ type: "text", text }], details: result, structuredContent: result };
		},
	});

	pi.registerCommand("dismiss", {
		description: "Discard the staged command",
		async handler(_args, ctx) {
			const hadCommand = pending !== undefined;
			clear(ctx);
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
