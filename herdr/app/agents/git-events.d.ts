export function affectsGitStatus(root: string, paths: string[]): boolean;
export class GitInvalidations {
  revision(key: string): number;
  changed<Context>(keys: Iterable<string>, schedule: (callback: (cx: Context) => void) => void, refresh: (cx: Context) => void): void;
}
