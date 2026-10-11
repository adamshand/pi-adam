import type { ChecklistItem } from "./work-item-store.js";
export type RemoteWorkItem = {
 id: string; title: string; description: string; state: "inbox" | "open" | "done" | "dropped";
 project: { slug: string } | null; source: string; revision: number; created_at: string; updated_at: string;
};
export type WorkList = { items: RemoteWorkItem[]; project: string | null; stale: boolean; fetchedAt: string | null; error?: string; outbox?: { pending: number; blocked: number; path: string } };
export type WorkCapture = { item?: RemoteWorkItem; queued: boolean; key: string; blocked?: boolean; error?: string };
export type WorkChanges = { title?: string; description?: string; state?: RemoteWorkItem["state"]; comment?: string };
export class WorkError extends Error { status: number; constructor(message: string, status?: number); }
export function withWorkLock<T>(path: string, operation: () => Promise<T>): Promise<T>;
export function workDisplayId(item: RemoteWorkItem): string;
export function workAge(createdAt: string): string;
export function workDescription(intent?: string, checklist?: ChecklistItem[]): string;
export class WorkClient {
 constructor(options?: { env?: NodeJS.ProcessEnv; url?: string; stateDir?: string; timeout?: number; tokenProvider?: () => Promise<string> });
 url: string; stateDir: string;
 root(cwd: string): Promise<string>;
 project(cwd: string): Promise<{ root: string; project: string | null }>;
 list(cwd: string): Promise<WorkList>;
 resolve(cwd: string, id: string): Promise<RemoteWorkItem>;
 get(id: string): Promise<RemoteWorkItem>;
 patch(id: string, changes: WorkChanges): Promise<RemoteWorkItem>;
 patchWith(id: string, makeChanges: (current: RemoteWorkItem) => WorkChanges): Promise<RemoteWorkItem>;
 create(cwd: string, values: { title: string; intent?: string; checklist?: ChecklistItem[]; source?: "idea" | "agent" }, key?: string): Promise<WorkCapture>;
 flush(retryBlocked?: boolean): Promise<void>;
}
