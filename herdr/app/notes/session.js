/* oxlint-disable anti-slop/no-runtime-typeof -- This file IS the JSON I/O boundary: the complete native label/plan contracts are validated here. GPUI mods cannot import npm schema libraries. */
// Pure, shared with Node tests; no Herdr/GPUI imports or writes.
export const LABEL = "pi-adam.todos";
export const STATUS = ["in_progress", "ready", "done"];

const absolute = path => typeof path === "string" && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
export function sessionPath(cwd, id) {
  const sep = cwd.includes("\\") ? "\\" : "/";
  const file = encodeURIComponent(id).replaceAll(".", "%2E").replaceAll("_", "%5F");
  return cwd.replace(/[\\/]+$/, "") + sep + [".pi", "todos", file + ".json"].join(sep);
}

export function resolveSession(focus, all) {
  const address = focus?.shown || focus?.terminal || null;
  const terminal = all.find(t => t.address === address && t.state === "live");
  const raw = terminal?.labels?.[LABEL];
  const on = address?.includes("/") ? address.slice(0, address.indexOf("/")) : null;
  const key = JSON.stringify([address, raw ?? null, terminal?.state ?? null]);
  const result = { key, address, on, session: null, message: "Focus a Pi terminal to see its Todos." };
  if (!terminal) return result;
  if (!raw) {
    if (terminal.program?.key === "pi" || terminal.report?.app === "pi") result.message = "Run /reload in this Pi session to connect its Todos.";
    return result;
  }
  try {
    const session = JSON.parse(raw);
    if (session.version !== 1 || typeof session.owner !== "string" || !session.owner
      || typeof session.session_id !== "string" || !session.session_id || session.session_id.length > 200
      || !absolute(session.cwd) || !absolute(session.todo_path)
      || session.todo_path !== sessionPath(session.cwd, session.session_id)
      || (session.name !== undefined && typeof session.name !== "string")) throw new Error("Invalid session reference");
    return { ...result, session, message: "" };
  } catch {
    return { ...result, message: "Invalid Pi session reference. Run /reload in Pi to reconnect." };
  }
}

function checklist(items, depth = 0) {
  if (items === undefined) return [];
  if (!Array.isArray(items) || depth > 2) throw new Error("Invalid Todo checklist");
  return items.map(item => {
    if (!item || typeof item.text !== "string" || (item.done !== undefined && typeof item.done !== "boolean")) throw new Error("Invalid Todo checklist item");
    const children = item.items === undefined ? [] : checklist(item.items, depth + 1);
    return { text: item.text, done: item.done === true, items: children };
  });
}

export function checklistProgress(items) {
  return items.reduce((total, item) => {
    const child = item.items.length ? checklistProgress(item.items) : { done: Number(item.done), total: 1 };
    return { done: total.done + child.done, total: total.total + child.total };
  }, { done: 0, total: 0 });
}

export function parsePlan(text, sessionId) {
  if (text === null) return { todos: [], missing: true };
  const plan = JSON.parse(text);
  if (plan.schema_version !== 2 || plan.session_id !== sessionId || !Array.isArray(plan.todos)) throw new Error("Todo file does not match this Pi session");
  const ids = new Set();
  const todos = plan.todos.map(todo => {
    if (!todo || todo.kind !== "todo" || todo.owner_session_id !== sessionId
      || typeof todo.id !== "string" || !todo.id || ids.has(todo.id)
      || typeof todo.title !== "string" || !STATUS.includes(todo.status)
      || (todo.intent !== undefined && typeof todo.intent !== "string")
      || (todo.progress !== undefined && typeof todo.progress !== "string")) throw new Error("Invalid Todo or session ownership");
    ids.add(todo.id);
    return {
      id: todo.id, title: todo.title, status: todo.status, intent: todo.intent || "",
      progress: todo.progress || "", checklist: checklist(todo.checklist)
    };
  });
  return { todos, missing: false };
}

// Generation + request guards: an old session's slow read (or error) cannot
// overwrite the newly focused session. Never retain another session's Todos.
export class TodoFeed {
  constructor(read) { this.read = read; this.generation = 0; this.context = null; this.select(null); }
  select(context) {
    if (this.context?.key === context?.key && this.generation) return false;
    this.context = context; this.generation++;
    this.todos = []; this.missing = false; this.error = ""; this.loading = false;
    this.loaded = false; this.lastReadAt = 0; this.signature = ""; this.request = 0;
    return true;
  }
  async refresh() {
    const context = this.context;
    if (!context?.session || this.loading) return false;
    const generation = this.generation, request = ++this.request;
    this.loading = true;
    try {
      const text = await this.read(context.session.todo_path, { on: context.on });
      const plan = parsePlan(text, context.session.session_id);
      if (generation !== this.generation || request !== this.request) return false;
      const signature = JSON.stringify(plan);
      const changed = signature !== this.signature || Boolean(this.error);
      this.todos = plan.todos; this.missing = plan.missing; this.error = ""; this.signature = signature;
      return changed;
    } catch (error) {
      if (generation !== this.generation || request !== this.request) return false;
      const message = "Cannot read this session's Todos: " + String(error.message ?? error);
      const changed = this.error !== message || this.todos.length > 0;
      this.todos = []; this.error = message; this.signature = "";
      return changed;
    } finally {
      if (generation === this.generation && request === this.request) {
        this.loading = false; this.loaded = true; this.lastReadAt = Date.now();
      }
    }
  }
}
