import { mkdtempSync, openSync, closeSync, readSync, fstatSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

export type TerminalInvocation = { file: string; args: string[]; cwd?: string };
const MAX_BYTES = 48 * 1024;
const MAX_LINES = 1000;

/** script allocates a PTY and records output only; never use input-recording -k/-r/-I flags. */
export function captureInvocation(invocation: TerminalInvocation, outputPath: string, platform = process.platform): TerminalInvocation {
	if (platform === "darwin") return { file: "/usr/bin/script", args: ["-q", "-e", outputPath, invocation.file, ...invocation.args], cwd: invocation.cwd };
	if (platform === "linux") {
		const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
		return { file: "/usr/bin/script", args: ["-q", "-e", "-c", [invocation.file, ...invocation.args].map(quote).join(" "), outputPath], cwd: invocation.cwd };
	}
	throw new Error("Interactive output capture currently supports macOS and Linux (util-linux script).");
}

export function createCapture(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-command-"));
	chmodSync(directory, 0o700);
	const path = join(directory, "output.txt");
	closeSync(openSync(path, "wx", 0o600));
	return path;
}

export function cleanTerminalOutput(text: string): string {
	// This is a transcript, not a full terminal emulator. Keep line breaks but remove controls.
	// eslint-disable-next-line no-control-regex
	return stripVTControlCharacters(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, "").trim();
}

export function readCapture(path: string): string {
	const fd = openSync(path, "r");
	try {
		const bytes = fstatSync(fd).size;
		const buffer = Buffer.alloc(Math.min(bytes, MAX_BYTES));
		const count = readSync(fd, buffer, 0, buffer.length, Math.max(0, bytes - buffer.length));
		const lines = cleanTerminalOutput(buffer.subarray(0, count).toString("utf8")).split("\n");
		const truncated = bytes > MAX_BYTES || lines.length > MAX_LINES;
		const output = lines.slice(-MAX_LINES).join("\n") || "(no output)";
		return truncated ? `${output}\n\n[Output truncated to final ${MAX_LINES} lines / ${MAX_BYTES} bytes. Full raw terminal transcript: ${path}]` : output;
	} finally { closeSync(fd); }
}
