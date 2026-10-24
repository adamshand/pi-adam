import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatPassages, rankPassages, readPassages, transcriptPassages, type TranscriptPassage } from "./session-search.ts";

function passage(id: string, text: string): TranscriptPassage {
	return { id, text, role: "user", timestamp: "2026-01-01", offset: 0 };
}

test("BM25 ranks distinctive matches, handles case, Unicode, and empty results", () => {
	const docs = [passage("a", "fast mode enabled"), passage("b", "Astra priority fast mode"), passage("c", "café settings")];
	assert.equal(rankPassages(docs, "ASTRA fast", 2)[0].id, "b");
	assert.equal(rankPassages(docs, "CAFÉ", 1)[0].id, "c");
	assert.deepEqual(rankPassages(docs, "unknown", 5), []);
	assert.deepEqual(rankPassages(docs, "!!!", 5), []);
	assert.deepEqual(rankPassages([], "fast", 5), []);
	assert.deepEqual(rankPassages(docs, "fast fast", 2), rankPassages(docs, "fast", 2));
});

test("extracts original messages across compaction and chunks long text", () => {
	const entries: SessionEntry[] = [
		{ type: "message", id: "old", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "x".repeat(1300), timestamp: 0 } },
		{ type: "message", id: "tool", parentId: "old", timestamp: "2026-01-01", message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "excluded tool output" }], isError: false, timestamp: 0 } },
		{ type: "compaction", id: "compact", parentId: "old", timestamp: "2026-01-02", summary: "not indexed", firstKeptEntryId: "old", tokensBefore: 100 },
		{ type: "message", id: "new", parentId: "compact", timestamp: "2026-01-03", message: { role: "user", content: [{ type: "text", text: "latest decision" }], timestamp: 0 } },
	];
	const docs = transcriptPassages(entries);
	assert.equal(docs.length, 3);
	assert.equal(docs[1].offset, 1200);
	assert.equal(docs[1].text.length, 100);
	assert.equal(docs[2].text, "latest decision");
	assert.deepEqual(readPassages(docs, "old", 1200), docs);
	assert.throws(() => readPassages(docs, "missing", 0), /not found/);
	assert.throws(() => readPassages(docs, "old", 1), /not found/);
});

test("result formatting carries references and enforces output budget", () => {
	assert.match(formatPassages([passage("ref", "decision")]), /id=ref · offset=0/);
	assert.match(formatPassages([]), /alternate search terms/);
	const output = formatPassages([passage("big", "x".repeat(20000))]);
	assert.ok(output.length < 12500);
	assert.match(output, /Output truncated/);
});
