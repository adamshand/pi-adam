import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureInvocation, createCapture, cleanTerminalOutput, readCapture } from "./staged-command-output.ts";

const supported = (process.platform === "darwin" || process.platform === "linux") && spawnSync("python3", ["--version"]).status === 0;
const fixture = fileURLToPath(new URL("./staged-command-pty-fixture.py", import.meta.url));

test("PTY capture preserves exit status, stdout/stderr, and terminal availability", { skip: !supported }, () => {
	const path = createCapture();
	try {
		const command = captureInvocation({ file: "/bin/sh", args: ["-c", "test -t 0 && test -t 1 || exit 9; printf 'hello\\n'; printf 'error\\n' >&2; exit 7"] }, path);
		const result = spawnSync("python3", [fixture, "no-secret", command.file, ...command.args], { encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, 7, result.stderr);
		assert.match(readCapture(path), /hello/);
		assert.match(readCapture(path), /error/);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
	} finally { rmSync(dirname(path), { recursive: true }); }
});

test("PTY capture does not record input when the child disables terminal echo", { skip: !supported, timeout: 15000 }, () => {
	const path = createCapture();
	try {
		const command = captureInvocation({ file: "/bin/sh", args: ["-c", "stty -echo; printf 'READY\\n'; IFS= read -r password; stty echo; printf '\\nfinished\\n'"] }, path);
		const result = spawnSync("python3", [fixture, "secret", command.file, ...command.args], { encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, 0, result.stderr);
		assert.match(readCapture(path), /finished/);
		assert.ok(!readFileSync(path, "utf8").includes("fake-secret"));
		assert.ok(!result.stdout.includes("fake-secret"));
	} finally { rmSync(dirname(path), { recursive: true }); }
});

test("context output is sanitized and bounded, with a full private transcript path", () => {
	const path = createCapture();
	try {
		assert.equal(cleanTerminalOutput("\x1b[31mred\x1b[0m\r\nokay\x00"), "red\nokay");
		writeFileSync(path, "line\n".repeat(20000) + "LAST\n");
		const output = readCapture(path);
		assert.match(output, /LAST/);
		assert.match(output, /Output truncated/);
		assert.ok(output.includes(path));
		assert.ok(Buffer.byteLength(output) < 50000);
		assert.equal(readFileSync(path, "utf8").length, 100005);
	} finally { rmSync(dirname(path), { recursive: true }); }
});

test("platform transports never enable input logging", () => {
	for (const platform of ["darwin", "linux"] as const) {
		const invocation = captureInvocation({ file: "/bin/sh", args: ["-c", "printf '%s' \"a'b\""], cwd: "/tmp" }, "/tmp/output", platform);
		assert.equal(invocation.cwd, "/tmp");
		assert.ok(!invocation.args.includes("-k"));
		assert.ok(!invocation.args.includes("-r"));
		assert.ok(!invocation.args.includes("-I"));
	}
	assert.throws(() => captureInvocation({ file: "sh", args: [] }, "/tmp/output", "win32"));
});
