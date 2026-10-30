/* oxlint-disable anti-slop/no-runtime-typeof -- Complete validation of native Ideas JSON I/O; GPUI cannot import npm schema libraries. */
import { resolveSession } from "./model.js";
const absolute = path => typeof path === "string" && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
const validOrigin = value => typeof value === "string" && (/^https:\/\/[^/?#@\s]+$/.test(value) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(value));
export function resolveIdeasContext(focus, all, spaces, config = {}) {
  const sessionContext = resolveSession(focus, all), session = sessionContext.session;
  const space = spaces.find(space => space.id === focus?.space);
  const on = sessionContext.on || space?.machine || null;
  const cwd = session?.cwd || focus?.cwd || space?.folder || null;
  // A local path must NEVER be used on another machine. Remote Pi publishes
  // its own reader and Node executable; unbound remote shells fail explicitly.
  const reader = session?.ideas_reader || (!on ? config.ideas_reader : null);
  const node = session?.node || (!on ? config.node || "node" : null);
  const message = !absolute(cwd) ? "Focus a terminal to see project Ideas."
    : !absolute(reader) || (node !== "node" && !absolute(node)) ? (on ? "Reload Pi on this machine to connect project Ideas." : "The local Ideas reader is not configured.") : "";
  return { key: JSON.stringify([on, cwd, reader ?? null, node ?? null]), cwd, on, reader, node, message };
}

export function parseIdeas(text, context) {
  const data = JSON.parse(text);
  if (data.version !== 1 || data.cwd !== context.cwd || !Array.isArray(data.items)
    || (data.project !== null && typeof data.project !== "string")
    || typeof data.scopeResolved !== "boolean" || typeof data.stale !== "boolean"
    || (data.fetchedAt !== null && (typeof data.fetchedAt !== "string" || !Number.isFinite(Date.parse(data.fetchedAt))))
    || (data.url !== undefined && !validOrigin(data.url))
    || (data.error !== undefined && typeof data.error !== "string")) throw new Error("Invalid Ideas snapshot or project context");
  const ids = new Set();
  const items = data.items.map(item => {
    if (!item || typeof item.id !== "string" || !/^work_[a-f0-9]{24}$/.test(item.id) || ids.has(item.id)
      || typeof item.title !== "string" || typeof item.description !== "string"
      || !["inbox", "open"].includes(item.state) || typeof item.source !== "string"
      || (item.project?.slug ?? null) !== data.project
      || typeof item.updated_at !== "string" || !Number.isFinite(Date.parse(item.updated_at))) throw new Error("Invalid Idea or project ownership");
    ids.add(item.id);
    return { id: item.id, title: item.title, description: item.description, state: item.state, source: item.source, updated_at: item.updated_at };
  });
  if (!data.scopeResolved && items.length) throw new Error("Ideas have no resolved project scope");
  items.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.id.localeCompare(b.id));
  const pending = data.outbox?.pending ?? 0, blocked = data.outbox?.blocked ?? 0;
  if (!Number.isInteger(pending) || pending < 0 || !Number.isInteger(blocked) || blocked < 0 || blocked > pending) throw new Error("Invalid Work outbox counts");
  return { items, project: data.project, scopeResolved: data.scopeResolved, stale: data.stale, fetchedAt: data.fetchedAt, url: data.url || null, error: data.error || "", pending, blocked };
}

const empty = () => ({ items: [], project: null, scopeResolved: false, stale: true, fetchedAt: null, url: null, error: "", pending: 0, blocked: 0 });
export class IdeasFeed {
  constructor(read) { this.read = read; this.context = null; this.generation = 0; this.select(null); }
  select(context) {
    if (this.generation && this.context?.key === context?.key) return false;
    this.context = context; this.generation++; this.snapshot = empty();
    this.loading = false; this.loaded = false; this.lastReadAt = 0; this.signature = "";
    return true;
  }
  async refresh(changed = () => {}) {
    const context = this.context;
    if (!context || context.message || this.loading) return;
    const generation = this.generation;
    const current = () => generation === this.generation;
    const apply = snapshot => {
      if (!current()) return;
      const signature = JSON.stringify(snapshot);
      this.snapshot = snapshot;
      if (signature !== this.signature) { this.signature = signature; changed(); }
    };
    this.loading = true;
    try {
      if (!this.loaded) {
        try {
          const cached = parseIdeas(await this.read(context, "cached"), context);
          if (!current()) return;
          apply({ ...cached, stale: true });
        } catch { /* A broken/missing cache must not prevent an online refresh. */ }
      }
      if (!current()) return;
      const fresh = parseIdeas(await this.read(context, "refresh"), context);
      if (current()) apply(fresh);
    } catch {
      if (current()) apply({ ...this.snapshot, stale: true, error: "Work is unavailable. Showing cached Ideas if available." });
    } finally {
      if (current()) { this.loading = false; this.loaded = true; this.lastReadAt = Date.now(); changed(); }
    }
  }
}
