import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDiagnosticError } from "./diagnostics.ts";

test("sanitizes secrets, control characters, and oversized diagnostic errors", () => {
	const message = `\u001b[31mAuthorization: Bearer sk-secretsecret accountId=acct_1234567890abcdef\u0000 ${"x".repeat(700)}`;
	const sanitized = sanitizeDiagnosticError(message);

	assert.ok(!sanitized.includes("\u001b"));
	assert.ok(!sanitized.includes("sk-secretsecret"));
	assert.ok(!sanitized.includes("acct_1234567890abcdef"));
	assert.ok(!sanitized.includes("\u0000"));
	assert.ok(sanitized.length <= 500);
});
