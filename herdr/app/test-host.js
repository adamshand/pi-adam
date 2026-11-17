// Faithful in-memory boundary for exercising native View lifecycles in Node.
// Production modules still use Herdr/GPUI; only their unavailable host imports
// are resolved here. Native `herdr-app check` remains required as well.
import { registerHooks } from "node:module";

export const state = {};
export function reset() {
  Object.assign(state, {
    checking: false, active: false, agents: [], terminals: [], panes: [], spaces: [],
    focus: {}, props: {}, shared: {}, layout: null, stored: new Map(), writes: [],
    calls: [], watches: [], timers: [], tasks: [], elements: [], scrolls: [],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
}
reset();
export const checking = () => state.checking;
export const agents = () => state.agents;
export const terminals = () => state.terminals;
export const panes = () => state.panes;
export const spaces = () => state.spaces;
export const focused = () => state.focus;
export const props = () => state.props;
export const window = () => ({ active: state.active });
export const layout = () => state.layout;
export const theme = () => ({});
export const home = () => "/home/test";
export const shared = key => state.shared[key];
export const setShared = (key, value) => { state.calls.push({ command: "setShared", key, value }); };
export const setAgentOrder = order => { state.calls.push({ command: "setAgentOrder", order }); };
export const run = (command, args) => { state.calls.push({ command, args }); };
export const openOverlay = args => { state.calls.push({ command: "openOverlay", args }); };
export const closeOverlay = id => { state.calls.push({ command: "closeOverlay", id }); };
export const notify = args => { state.calls.push({ command: "notify", args }); };
export async function exec(command, args, options) {
  state.calls.push({ command, args, options });
  return state.exec(command, args, options);
}
export async function readTextFile(path) { state.calls.push({ command: "readTextFile", path }); return null; }
export async function writeTextFile(...args) { state.calls.push({ command: "writeTextFile", args }); }
export const nextCommand = () => new Promise(() => {});
export function watchFolder(root) {
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const watch = { root, cancelled: false, resolve, reject };
  pending.cancel = () => { watch.cancelled = true; resolve([]); };
  state.watches.push(watch);
  return pending;
}

export function context() {
  const cx = {
    notify() {},
    spawn(fn) { const task = fn(cx); state.tasks.push(task); return task; },
    timer: {
      every(ms, fn) { state.timers.push({ ms, fn }); },
      after(ms, fn) { state.timers.push({ ms, fn }); },
    },
  };
  return cx;
}
export async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

export class View {}
export function div() {
  const node = { children: [], events: {} };
  state.elements.push(node);
  const element = new Proxy(node, { get(_target, method) {
    return (...args) => {
      if (method === "when" && args[0]) args[1](element);
      if (method === "child") node.children.push(args[0]);
      if (method === "children") node.children.push(...args[0]);
      if (method === "id") node.id = args[0];
      if (String(method).startsWith("on_")) node.events[method] = args.at(-1);
      return element;
    };
  } });
  return element;
}
export const svg = div;
export const image = div;
export const h_flex = div;
export const v_flex = div;
export const ScrollHandle = { new: () => ({ scroll_to_item(index) { state.scrolls.push(index); } }) };
export const Button = { new: div };
export const Textarea = { new: div };
export const TextareaState = { new() { throw new Error("Unexpected editor creation"); } };
export const TextView = { markdown: div };

export async function loadViews() {
  globalThis.localStorage = {
    getItem: key => state.stored.get(key) ?? null,
    setItem: (key, value) => { state.writes.push({ key, value }); state.stored.set(key, value); },
    removeItem: key => { state.writes.push({ key }); state.stored.delete(key); },
  };
  const hooks = registerHooks({ resolve(specifier, ctx, next) {
    if (["herdr", "gpui-kit", "gpui-base"].includes(specifier)) return { url: import.meta.url, shortCircuit: true };
    return next(specifier, ctx);
  } });
  try {
    const [{ default: Agents }, { default: Tabs }, { default: Todos }, { default: Notes }, { default: Status }] = await Promise.all([
      import("./agents/main.js"), import("./tabs/main.js"), import("./todos/main.js"), import("./notes/main.js"), import("./status/main.js"),
    ]);
    return { Agents, Tabs, Todos, Notes, Status };
  } finally { hooks.deregister(); }
}

export function textChildren() {
  return state.elements.flatMap(node => node.children.filter(child => child?.constructor === String));
}
