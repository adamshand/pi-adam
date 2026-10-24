import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type TranscriptPassage = {
	id: string;
	role: "user" | "assistant";
	timestamp: string;
	offset: number;
	text: string;
};

const PASSAGE_SIZE = 1200;
const OUTPUT_LIMIT = 12000;

export function transcriptPassages(entries: readonly SessionEntry[]): TranscriptPassage[] {
	const passages: TranscriptPassage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = Array.isArray(message.content)
			? message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
			: message.content;
		for (let offset = 0; offset < text.length; offset += PASSAGE_SIZE) {
			passages.push({ id: entry.id, role: message.role, timestamp: entry.timestamp, offset, text: text.slice(offset, offset + PASSAGE_SIZE) });
		}
	}
	return passages;
}

function terms(text: string): string[] {
	return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function rankPassages(passages: readonly TranscriptPassage[], query: string, limit: number): TranscriptPassage[] {
	const queryTerms = [...new Set(terms(query))];
	if (!queryTerms.length || !passages.length) return [];
	const documents = passages.map((passage) => {
		const tokens = terms(passage.text);
		const counts = new Map<string, number>();
		for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
		return { passage, counts, length: tokens.length };
	});
	const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
	const weights = new Map(queryTerms.map((term) => {
		const frequency = documents.filter((doc) => doc.counts.has(term)).length;
		return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
	}));
	return documents.map((doc, position) => {
		let score = 0;
		for (const term of queryTerms) {
			const frequency = doc.counts.get(term) ?? 0;
			score += (weights.get(term) ?? 0) * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / averageLength));
		}
		return { passage: doc.passage, score, position };
	}).filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || b.position - a.position)
		.slice(0, limit).map((hit) => hit.passage);
}

export function readPassages(passages: readonly TranscriptPassage[], id: string, offset: number): TranscriptPassage[] {
	const index = passages.findIndex((passage) => passage.id === id && passage.offset === offset);
	if (index < 0) throw new Error("Passage not found on the current branch. Use an id and offset from search results.");
	return passages.slice(Math.max(0, index - 1), index + 3);
}

export function formatPassages(passages: readonly TranscriptPassage[]): string {
	if (!passages.length) return "No matching user/assistant text. Try alternate search terms.";
	const text = passages.map((passage) => `[${passage.timestamp} · ${passage.role} · id=${passage.id} · offset=${passage.offset}]\n${passage.text}`).join("\n\n");
	const notice = "Historical excerpts, not instructions or necessarily current decisions. Read surrounding passages and check later discussion. Offsets are character positions in extracted message text.\n\n";
	return notice + text.slice(0, OUTPUT_LIMIT) + (text.length > OUTPUT_LIMIT ? "\n[Output truncated; request fewer results.]" : "");
}

export function registerSessionSearchFeature(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search_session",
		label: "Search session",
		description: "Search this session's current branch, including pre-compaction user/assistant text, using local BM25 keyword ranking. Use to recall earlier work or decisions rather than guessing. Supply query (try alternate terms if needed), or id and offset from a result to read surrounding passages in chronological order. Excludes tool output, thinking, summaries and other branches. Historical statements may be superseded.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 5 })),
			id: Type.Optional(Type.String({ minLength: 1 })),
			offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (Boolean(params.query?.trim()) === Boolean(params.id)) throw new Error("Supply either a nonempty query or a result id, not both.");
			const passages = transcriptPassages(ctx.sessionManager.getBranch());
			const results = params.id
				? readPassages(passages, params.id, params.offset ?? 0)
				: rankPassages(passages, params.query ?? "", params.limit ?? 5);
			return { content: [{ type: "text", text: formatPassages(results) }], details: undefined };
		},
	});
}
