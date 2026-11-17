export type ProjectNotes = { name: string; path: string };
export function resolveProjectNotes(cwd: string, home?: string, signal?: AbortSignal): Promise<ProjectNotes>;
export function projectNotes(cwd: string, home?: string): Promise<ProjectNotes>;
