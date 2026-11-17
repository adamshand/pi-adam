import { Type, type Static } from "typebox";

/** A closed span witnessed by two renders of the same native mod instance. */
export const FocusSpanSchema = Type.Object({
	providerStartedAt: Type.Integer({ minimum: 0 }),
	provider: Type.String({ minLength: 1, maxLength: 128 }),
	sequence: Type.Integer({ minimum: 1 }),
	start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }),
	focused: Type.Boolean(),
}, { additionalProperties: false });
export type FocusSpan = Static<typeof FocusSpanSchema>;
export type CoverageSpan = { start: number; end: number; idle: boolean };

/** No extrapolation: loss of the provider leaves its unwitnessed tail unknown. */
export class FocusCoverage {
	private provider: string | undefined;
	private sequence = 0;
	private end = 0;
	private providerStartedAt = -1;
	private activity: { at: number; waiting: boolean }[] = [];
	reset(at: number): void {
		this.provider = undefined;
		this.sequence = 0;
		this.end = at;
		this.providerStartedAt = -1;
		this.activity = [{ at, waiting: true }];
	}
	waiting(at: number, waiting: boolean): void {
		const last = this.activity.at(-1);
		if (!last || at < last.at || last.waiting === waiting) return;
		this.activity.push({ at, waiting });
		// Pathological long runs lose old coverage conservatively, never grow without bound.
		if (this.activity.length > 4096) this.activity.shift();
	}
	clone(): FocusCoverage {
		const copy = new FocusCoverage();
		Object.assign(copy, this, { activity: this.activity.map(item => ({ ...item })) });
		return copy;
	}
	accept(span: FocusSpan, now: number): CoverageSpan[] {
		if (span.end < span.start || span.end > now || now - span.end > 5000) return [];
		if (span.providerStartedAt > span.start) return [];
		const replacing = this.provider !== span.provider;
		if (!replacing && span.providerStartedAt !== this.providerStartedAt) return [];
		// Total ordering needs only one high-water generation, not a growing retired-ID set.
		if (replacing && (span.providerStartedAt < this.providerStartedAt
			|| (span.providerStartedAt === this.providerStartedAt && span.provider <= (this.provider ?? "")))) return [];
		if (!replacing && (span.sequence <= this.sequence || span.start < this.end)) return [];
		const coveredStart = Math.max(span.start, this.end);
		this.providerStartedAt = span.providerStartedAt;
		this.provider = span.provider;
		this.sequence = span.sequence;
		this.end = Math.max(this.end, span.end);
		const result: CoverageSpan[] = [];
		for (let i = 0; i < this.activity.length; i++) {
			const item = this.activity[i];
			const start = Math.max(coveredStart, item.at);
			const end = Math.min(span.end, this.activity[i + 1]?.at ?? span.end);
			if (end > start) result.push({ start, end, idle: item.waiting && !span.focused });
		}
		while (this.activity.length > 1 && this.activity[1].at <= span.end) this.activity.shift();
		return result;
	}
}
