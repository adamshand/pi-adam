import type { WorkClient, RemoteWorkItem } from "./work-client.js";
export function workFixture(): Promise<{
 cwd: string; directory: string; client: WorkClient;
 options: { url: string; stateDir: string; env: { HAUME_WORK_API_TOKEN: string }; timeout: number };
 items: Map<string, RemoteWorkItem>;
 calls: Array<{ method: string; path: string; body?: { title?: string; description?: string; state?: string; comment?: string; revision?: number }; key?: string }>;
 control: { fail: number; loseCreateResponse: boolean; conflicts: number; delay: number };
 close(): Promise<void>;
}>;
