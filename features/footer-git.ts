import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export type FooterGitStats = { added: number; removed: number; ahead?: number; behind?: number };

export async function readFooterGitStats(pi: ExtensionAPI, cwd: string): Promise<FooterGitStats | undefined> {
	const [diff, upstream] = await Promise.all([
		pi.exec("git", ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", "-z", "HEAD", "--"], { cwd, timeout: 3000 }),
		pi.exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, timeout: 3000 }),
	]);
	if (diff.code !== 0) return undefined;
	const stats: FooterGitStats = { added: 0, removed: 0 };
	for (const record of diff.stdout.split("\0")) {
		const match = /^(\d+)\t(\d+)\t/.exec(record);
		if (!match) continue; // Binary files have no line counts.
		stats.added += Number(match[1]);
		stats.removed += Number(match[2]);
	}
	const counts = upstream.code === 0 ? /^(\d+)\s+(\d+)\s*$/.exec(upstream.stdout) : null;
	if (counts) {
		stats.ahead = Number(counts[1]);
		stats.behind = Number(counts[2]);
	}
	return stats;
}

/** Preserve both existing sections; omit Git rather than squeeze them. */
export function centeredFooter(width: number, left: string, center: string, right: string): string | undefined {
	if (!center) return undefined;
	const leftWidth = visibleWidth(left);
	const centerWidth = visibleWidth(center);
	const rightStart = width - visibleWidth(right);
	const minimumStart = leftWidth + 2;
	const maximumStart = rightStart - centerWidth - 2;
	if (maximumStart < minimumStart) return undefined;
	const start = Math.max(minimumStart, Math.min(Math.floor((width - centerWidth) / 2), maximumStart));
	return left + " ".repeat(start - leftWidth) + center + " ".repeat(rightStart - start - centerWidth) + right;
}
