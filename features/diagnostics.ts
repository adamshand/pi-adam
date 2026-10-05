const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");
const DEFAULT_MAX_LENGTH = 500;

function replaceControlCharacters(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		result += code <= 31 || (code >= 127 && code <= 159) ? " " : character;
	}
	return result;
}

export function sanitizeDiagnosticError(message: string, maxLength = DEFAULT_MAX_LENGTH): string {
	const withoutSecrets = message
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
		.replace(/\bacct_[A-Za-z0-9_-]{6,}\b/g, "acct_[REDACTED]")
		.replace(
			/(["']?(?:access|access_token|token|api[_-]?key|authorization|accountId|account_id)["']?\s*[:=]\s*["']?)([^"',\s}\]]+)/gi,
			"$1[REDACTED]",
		);
	const normalized = replaceControlCharacters(withoutSecrets).replace(/ +/g, " ").trim() || "Unknown error.";
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
