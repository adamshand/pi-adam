import { FocusReporter, terminalFocused } from "./focus.js";
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, focused, theme, run, window, exec, notify, checking } from "herdr";
import { focusedMetrics, metricParts, visibleMetricParts, metricControl, controlInvocation, footerTooltip } from "./model.js";

/** Personal clone of workspace-status: Pi metrics belong to the active terminal only. */
export default class WorkspaceStatus extends View {
  init() {
    this.width = 0;
    this.focusReporter = new FocusReporter(`${Date.now()}-${Math.random()}`);
    this.focusQueues = new Map();
    this.closed = false;
    this.hosted = new Map();
    this.announcing = new Set();
    this.changing = false;
  }

  announce(list, cx) {
    if (checking() || this.closed) return;
    for (const terminal of list) {
      const data = focusedMetrics({ terminal: terminal.address }, [terminal]);
      if (!data || this.announcing.has(terminal.address)) continue;
      this.hosted.set(terminal.address, data.owner);
      if (terminal.labels?.["pi-adam.footer-host"] === data.owner) continue;
      this.announcing.add(terminal.address);
      cx.spawn(async () => {
        try {
          await exec("hc", ["label", terminal.address, `pi-adam.footer-host=${data.owner}`]);
        } catch {
          // Core reconnect/live data changes retry; do not spin a redraw loop.
        } finally {
          this.announcing.delete(terminal.address);
        }
      });
    }
  }

  reportFocus(list, cx) {
    if (checking() || this.closed) return;
    const focus = focused();
    const active = window()?.active;
    if (active !== true && active !== false) { this.focusReporter.records.clear(); return; }
    const live = new Set();
    for (const terminal of list) {
      if (terminal.address.includes("/")) continue;
      const data = focusedMetrics({ terminal: terminal.address }, [terminal]);
      if (!data?.controls) continue;
      const subscribed = data.controls.focusSpans === true;
      if (!subscribed && !this.focusReporter.records.has(data.controls.owner)) continue;
      const key = data.controls.owner;
      if (subscribed) live.add(key);
      const span = this.focusReporter.observe(key, terminalFocused(terminal.address, focus, active), Date.now(), data.controls.focusEpoch);
      if (!subscribed) this.focusReporter.forget(key);
      if (!span) continue;
      const queue = this.focusQueues.get(key);
      if (queue) {
        if (queue.length < 32) queue.push(span);
        else { queue.length = 0; this.focusReporter.forget(key); }
        continue;
      }
      const pending = [span];
      this.focusQueues.set(key, pending);
      const invocation = controlInvocation(data, terminal.address, "focus");
      cx.spawn(async () => {
        try {
          while (pending.length && !this.closed) {
            const next = pending.shift();
            const result = await exec(invocation.command, [...invocation.args, JSON.stringify(next)], { timeout: 6000 });
            if (result.code !== 0 || !JSON.parse(result.stdout)?.ok) { this.focusReporter.forget(key); break; }
          }
        } catch {
          this.focusReporter.forget(key);
          // A later live render can establish a fresh span. Never replay failed delivery.
        } finally {
          if (pending.length) this.focusReporter.forget(key);
          this.focusQueues.delete(key);
        }
      });
    }
    for (const key of this.focusReporter.records.keys()) {
      if (!live.has(key)) this.focusReporter.forget(key);
    }
  }

  change(data, address, action, cx) {
    if (checking() || this.closed || this.changing || !metricControl(data, action)?.enabled) return;
    this.changing = true;
    cx.notify();
    const invocation = controlInvocation(data, address, action);
    cx.spawn(async cx => {
      try {
        const result = await exec(invocation.command, invocation.args, { on: invocation.on });
        const response = result.code === 0 ? JSON.parse(result.stdout) : null;
        if (!response?.ok) notify({ title: "Pi footer", body: response?.error ?? "Pi controls are unavailable. Reload the Pi session.", level: "warning" });
      } catch {
        notify({ title: "Pi footer", body: "Pi controls are unavailable. Reload the Pi session.", level: "warning" });
      } finally {
        this.changing = false;
        cx.notify();
      }
    });
  }

  metric(part, data, address, t) {
    const control = metricControl(data, part.kind);
    const enabled = control?.enabled && !this.changing;
    return div().id(`metric-${part.kind}-${part.text}`).px(3).py(2).rounded(3).text_color(t[part.tone])
      .when(part.kind === "model", item => item.min_w(0).max_w(180).truncate())
      .when(part.kind !== "model", item => item.flex_none())
      .when(Boolean(part.tooltip), item => item.tooltip(part.tooltip))
      .when(Boolean(control), item => item.tooltip(this.changing ? "Applying Pi change…" : control.tooltip))
      .when(enabled, item => item.cursor_pointer().hover(style => style.bg(t.hover))
        .on_click((_event, cx) => { cx.stop_propagation(); this.change(data, address, part.kind, cx); }))
      .child(part.text);
  }

  async close() {
    this.closed = true;
    if (checking()) return;
    await Promise.allSettled([...this.hosted].map(async ([address, owner]) => {
      const result = await exec("hc", ["get", address]);
      if (result.code === 0 && JSON.parse(result.stdout).labels?.["pi-adam.footer-host"] === owner) {
        await exec("hc", ["label", address, "pi-adam.footer-host="]);
      }
    }));
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const all = terminals();
    this.announce(all, cx);
    this.reportFocus(all, cx);
    const focus = focused();
    const address = focus?.shown || focus?.terminal;
    const data = focusedMetrics(focus, all);
    const parts = data ? metricParts(data) : [];
    const label = (icon, text) => h_flex().gap(6).items_center().flex_none().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const roomy = !data || this.width >= 1100;
    return h_flex().id("status-root").size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .on_size_change((size, cx) => {
        if (this.width === size.width) return;
        this.width = size.width;
        cx.notify();
      })
      .when(!data || this.width >= 700, el => el.child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer")))
      .when(roomy && Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .when(roomy, el => el.child(h_flex().gap(6).items_center().flex_none().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, row => row.child(div().text_color(t.blocked).child(`· ${needs} needs you`)))))
      .child(div().flex_1())
      .when(Boolean(data), el => el.child(h_flex().id("pi-metrics").min_w(0).gap(10).items_center()
        .tooltip(footerTooltip(data))
        .children(visibleMetricParts(parts, this.width).map(part => this.metric(part, data, address, t)))))
      .when(!data, el => el.child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(`${window()?.platform === "macos" ? "⌘" : "Ctrl"} Shift P  commands`)));
  }
}
