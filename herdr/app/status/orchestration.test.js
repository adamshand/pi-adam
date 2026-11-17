// Native host imports are replaced only in this test, as requested by the review.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const hostUrl = `data:text/javascript,${encodeURIComponent(`
export const state = { terminals: [], focus: { terminal: "t0" }, active: true, checking: false, calls: [], fail: false, hold: null };
export const focused = () => state.focus;
export const checking = () => state.checking;
export const window = () => ({ active: state.active });
export const terminals = () => state.terminals;
export const agents = () => [];
export const spaces = () => [];
export const theme = () => ({});
export const run = () => {};
export const notify = () => {};
export async function exec(command, args) {
  state.calls.push({ command, args });
  if (state.hold) await state.hold;
  return { code: state.fail ? 1 : 0, stdout: '{"ok":true}' };
}
`)}`;
const kitUrl = `data:text/javascript,${encodeURIComponent(`
export class View {}
export function div() { const el = new Proxy({}, { get: () => () => el }); return el; }
export const svg = div;
export const h_flex = div;
`)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "herdr") return { url: hostUrl, shortCircuit: true };
  if (["gpui-kit", "gpui-base"].includes(specifier)) return { url: kitUrl, shortCircuit: true };
  return next(specifier, context);
} });
const { default: Status } = await import("./main.js");
const { state } = await import(hostUrl);
hooks.deregister();

function terminal(i, subscribed) {
  const owner = `owner${i}`;
  return { address: `t${i}`, state: "live", report: { app: "pi" }, labels: {
    "pi-adam.footer-host": owner,
    "pi-adam.footer": JSON.stringify({ version: 1, owner, session_id: `s${i}`, model: "test", thinking: "high", fast: null,
      cost: 0, contextTokens: 0, contextWindow: 1, controls: { owner, session: `s${i}`, socket: "/tmp/test", client: "client", node: "node", idle: true, actions: [], focusSpans: subscribed, focusEpoch: 1 } }),
  } };
}
function change(i, values) {
  const item = state.terminals[i];
  const data = JSON.parse(item.labels["pi-adam.footer"]);
  Object.assign(data.controls, values);
  item.labels["pi-adam.footer"] = JSON.stringify(data);
}

test("native renders spawn only subscribed transitions/checkpoints, with one final pause flush", async t => {
  let at = 1000;
  t.mock.method(Date, "now", () => at);
  const status = new Status(); status.init();
  state.terminals = Array.from({ length: 60 }, (_, i) => terminal(i, i < 30));
  state.calls = [];
  const tasks = [];
  const cx = { spawn(fn) { tasks.push(fn(cx)); }, notify() {} };
  status.render(cx);
  for (let i = 0; i < 100; i++) { at++; status.render(cx); }
  assert.equal(state.calls.length, 0);
  state.focus = { terminal: "t1" }; at++; status.render(cx);
  await Promise.all(tasks);
  assert.equal(state.calls.length, 2);
  at++; change(5, { focusEpoch: 2 }); status.render(cx);
  await Promise.all(tasks);
  assert.equal(state.calls.length, 3);
  at++; change(5, { focusSpans: false, focusEpoch: 3 }); status.render(cx);
  await Promise.all(tasks);
  assert.equal(state.calls.length, 4);
  for (let i = 0; i < 100; i++) { at++; status.render(cx); }
  assert.equal(state.calls.length, 4);
  state.active = false; at++; status.render(cx); await Promise.all(tasks);
  assert.equal(state.calls.length, 5); // Only the formerly focused tracking terminal changed.
  state.terminals = [terminal(0, false)];
  for (let i = 0; i < 10; i++) { at++; state.active = !state.active; status.render(cx); }
  await Promise.all(tasks);
  assert.equal(state.calls.length, 5);
});

test("queued native focus transitions retain order; overflow creates an explicit unknown gap", async t => {
  let at = 10000;
  t.mock.method(Date, "now", () => at);
  state.active = true; state.focus = { terminal: "t0" }; state.terminals = [terminal(0, true)]; state.calls = [];
  let release;
  state.hold = new Promise(resolve => { release = resolve; });
  const status = new Status(); status.init();
  const tasks = [];
  const cx = { spawn(fn) { tasks.push(fn(cx)); }, notify() {} };
  status.render(cx);
  for (let i = 0; i < 3; i++) { at++; state.active = !state.active; status.render(cx); }
  state.hold = null; release(); await Promise.all(tasks);
  assert.deepEqual(state.calls.map(call => JSON.parse(call.args.at(-1)).focused), [true, false, true]);
  state.calls = [];
  state.hold = new Promise(resolve => { release = resolve; });
  for (let i = 0; i < 35; i++) { at++; state.active = !state.active; status.render(cx); }
  assert.equal(status.focusQueues.get("owner0").length, 0);
  state.hold = null; release(); await Promise.all(tasks);
  at++; state.active = !state.active; status.render(cx); await Promise.all(tasks);
  const spans = state.calls.map(call => JSON.parse(call.args.at(-1)));
  assert.equal(spans.length, 2);
  assert.ok(spans[1].start > spans[0].end);
});
