// Read-only native Herdr panel. Identity comes from a core label, never a
// guessed "latest" session or the terminal's mutable shell working directory.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, terminals, layout, theme, readTextFile, watchFolder, window, nextCommand, run, exec, props, spaces } from "herdr";
import { resolveSession, TodoFeed, checklistProgress } from "./model.js";
import { IdeasFeed, resolveIdeasContext } from "./ideas-model.js";
import { ideasView } from "./ideas-view.js";
import { copyReferenceButton } from "./copy-reference.js";

const NAMES = { in_progress: "In progress", ready: "Ready", done: "Done" };
const GLYPHS = { in_progress: "◐", ready: "○", done: "✓" };
const color = (t, status) => status === "done" ? t.done : status === "in_progress" ? t.working : t.dim;
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}
function visible() {
  const tree = layout();
  const panel = find(tree, "panel");
  return window()?.active !== false && Boolean(panel) && !panel.hidden && find(tree, "panel-body")?.active === "todos";
}

export default class Todos extends View {
  init(_props, cx) {
    this.feed = new TodoFeed(readTextFile);
    this.config = props() ?? {};
    this.view = localStorage.getItem("view") === "ideas" ? "ideas" : "todos";
    this.ideaExpanded = new Set();
    this.copiedReference = null;
    this.ideas = new IdeasFeed(async (context, mode) => {
      const result = await exec(context.node, [context.reader, context.cwd, mode], { on: context.on });
      if (result.code !== 0) throw new Error("Ideas reader did not complete");
      return result.stdout;
    });
    this.expanded = new Set(); this.showDone = false; this.watching = new Set();
    // Local watches are immediate; polling recovers from missing folders and
    // refreshes remote plans, only while this panel is actually visible.
    cx.timer.every(1500, cx => this.refresh(cx));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "view:ideas") this.setView("ideas", cx);
        if (command === "view:todos") this.setView("todos", cx);
        if (command.startsWith("idea:")) this.toggleIdea(command.slice(5), cx);
        if (command === "completed") { this.showDone = !this.showDone; cx.notify(); }
        if (command === "refresh") this.refresh(cx, true);
        if (command.startsWith("detail:")) this.toggle(command.slice(7), cx);
      }
    });
  }

  sync() {
    const context = resolveSession(focused(), terminals());
    if (this.feed.select(context)) { this.expanded.clear(); this.showDone = false; }
    const project = resolveIdeasContext(focused(), terminals(), spaces(), this.config);
    if (this.ideas.select(project)) this.ideaExpanded.clear();
  }

  hide() { run("layout.hide", { id: "panel" }); }

  setView(view, cx) {
    this.view = view; localStorage.setItem("view", view);
    this.refresh(cx);
    cx.notify();
  }

  toggleIdea(id, cx) {
    if (!this.ideas.snapshot.items.some(item => item.id === id)) return;
    if (this.ideaExpanded.has(id)) this.ideaExpanded.delete(id);
    else this.ideaExpanded.add(id);
    cx.notify();
  }

  refresh(cx, force = false) {
    this.sync();
    if (this.view === "ideas") {
      if (!visible() || this.ideas.context?.message || this.ideas.loading) return;
      if (!force && Date.now() - this.ideas.lastReadAt < 30000) return;
      cx.spawn(async cx => { await this.ideas.refresh(() => cx.notify()); });
      return;
    }
    const context = this.feed.context;
    if (!visible() || !context?.session || this.feed.loading) return;
    const interval = context.on ? 5000 : 1500;
    if (!force && Date.now() - this.feed.lastReadAt < interval) return;
    cx.spawn(async cx => {
      const changed = await this.feed.refresh();
      if (context.key !== this.feed.context?.key) return;
      if (!context.on && !this.feed.error && !this.feed.missing) this.watch(context, cx);
      if (changed) cx.notify();
    });
  }

  watch(context, cx) {
    const path = context.session.todo_path;
    const root = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
    if (this.watching.has(root)) return;
    this.watching.add(root);
    cx.spawn(async cx => {
      try {
        while (this.feed.context?.session?.todo_path.startsWith(root + "/") || this.feed.context?.session?.todo_path.startsWith(root + "\\")) {
          await watchFolder(root);
          const current = this.feed.context?.session?.todo_path;
          if (this.view === "todos" && (current?.startsWith(root + "/") || current?.startsWith(root + "\\"))) this.refresh(cx, true);
        }
      } catch { /* The visible-only fallback retries missing/unwatchable directories. */ }
      finally { this.watching.delete(root); }
    });
  }

  toggle(id, cx) {
    const todo = this.feed.todos.find(todo => todo.id === id);
    if (!todo) return;
    const open = this.isExpanded(todo);
    this.expanded.delete(`${id}:open`); this.expanded.delete(`${id}:closed`);
    this.expanded.add(`${id}:${open ? "closed" : "open"}`);
    cx.notify();
  }

  isExpanded(todo) {
    return this.expanded.has(`${todo.id}:open`) || (todo.status === "in_progress" && !this.expanded.has(`${todo.id}:closed`));
  }

  checkItem(item, id, t, nested = false) {
    const progress = item.items.length ? checklistProgress(item.items) : null;
    const done = progress ? progress.done === progress.total : item.done;
    return v_flex().id(id).gap(5).when(nested, el => el.pl(18))
      .child(h_flex().gap(8).items_start()
        .child(div().w(12).flex_none().text_color(done ? t.done : t.dim).child(done ? "✓" : "□"))
        .child(div().flex_1().min_w(0).whitespace_normal().text_color(done ? t.dim : t.muted).child(item.text)))
      .when(item.items.length > 0, el => el.children(item.items.map((child, i) => this.checkItem(child, `${id}-${i}`, t, true))));
  }

  todoRow(todo, t) {
    const open = this.isExpanded(todo), progress = checklistProgress(todo.checklist);
    const details = Boolean(todo.intent || todo.progress || todo.checklist.length);
    return v_flex().id(`todo-${todo.id}`).flex_none().p(11).gap(9).rounded(8)
      .bg(todo.status === "in_progress" ? t.raised : t.background).border_1().border_color(todo.status === "in_progress" ? t.working + "66" : t.border)
      .child(h_flex().id(`todo-toggle-${todo.id}`).gap(9).items_start().cursor_pointer()
        .on_click((_e, cx) => this.toggle(todo.id, cx))
        .child(div().w(14).flex_none().text_color(color(t, todo.status)).child(GLYPHS[todo.status]))
        .child(v_flex().flex_1().min_w(0).gap(5)
          .child(div().whitespace_normal().font_medium().text_color(todo.status === "done" ? t.muted : t.foreground).child(todo.title))
          .when(progress.total > 0, el => el.child(div().text_size(10.5).text_color(t.dim).child(`${progress.done}/${progress.total} checklist items`))))
        .child(copyReferenceButton(this, todo, "todo", t))
        .when(details, el => el.child(svg(`mods/adam-todos/chevron-${open ? "down" : "right"}.svg`).size(12).mt(3).flex_none().text_color(t.dim))))
      .when(open && details, el => el.child(v_flex().pl(23).gap(10).text_size(12)
        .when(Boolean(todo.intent), el => el.child(v_flex().gap(3)
          .child(div().text_size(10).text_color(t.dim).child("INTENT"))
          .child(div().whitespace_normal().text_color(t.muted).child(todo.intent))))
        .when(Boolean(todo.progress), el => el.child(v_flex().gap(3)
          .child(div().text_size(10).text_color(t.working).child("PROGRESS"))
          .child(div().whitespace_normal().text_color(t.foreground).child(todo.progress))))
        .when(todo.checklist.length > 0, el => el.child(v_flex().gap(7).children(todo.checklist.map((item, i) => this.checkItem(item, `check-${todo.id}-${i}`, t)))))));
  }

  render(cx) {
    this.sync();
    if (this.view === "ideas" ? !this.ideas.loaded : !this.feed.loaded) this.refresh(cx);
    const t = theme();
    const tab = (view, label) => div().id(`work-view-${view}`).flex_1().h(30).flex().items_center().justify_center().rounded(6)
      .bg(this.view === view ? t.selected : t.chrome).text_color(this.view === view ? t.foreground : t.muted)
      .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.setView(view, cx)).child(label);
    return v_flex().id("work-panel").size_full().min_h(0).gap(6).text_size(12)
      .child(h_flex().h(36).flex_none().p(3).gap(3).rounded(8).bg(t.chrome)
        .child(tab("todos", "Todos")).child(tab("ideas", "Ideas")))
      .child(div().flex_1().min_h(0).child(this.view === "ideas" ? ideasView(this, t) : this.renderTodos()));
  }

  renderTodos() {
    const t = theme(), context = this.feed.context, session = context?.session;
    const todos = this.feed.todos, done = todos.filter(todo => todo.status === "done"), active = todos.filter(todo => todo.status === "in_progress"), ready = todos.filter(todo => todo.status === "ready");
    const total = todos.length;
    const group = (name, list, status) => list.length ? [
      h_flex().px(2).pt(5).gap(6).items_center().text_size(11).text_color(color(t, status))
        .child(div().child(name)).child(div().text_color(t.dim).child(String(list.length))),
      ...list.map(todo => this.todoRow(todo, t))
    ] : [];
    return v_flex().id("todos-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Todos"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${done.length}/${total} done`))
        .child(div().flex_1())
        .child(div().id("todos-refresh").px(4).text_color(t.dim).cursor_pointer().tooltip("Refresh Todos")
          .hover(s => s.text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx, true)).child("↻"))
        .child(div().id("todos-close").px(4).text_color(t.dim).cursor_pointer().tooltip("Hide Todos")
          .hover(s => s.text_color(t.foreground)).on_click(() => run("layout.hide", { id: "panel" })).child("×")))
      .when(Boolean(session), el => el.child(v_flex().flex_none().px(14).py(10).gap(5).border_b(1).border_color(t.border)
        .child(div().truncate().font_medium().text_size(12).child(session.name || "Pi session"))
        .child(div().truncate().text_size(10.5).text_color(t.dim).tooltip(session.cwd).child(`${context.address} · ${session.session_id.slice(0, 8)}`))
        .when(total > 0, el => el.child(h_flex().h(4).mt(4).gap(2).rounded(2).overflow_hidden().children([
          [done.length, "done"], [active.length, "in_progress"], [ready.length, "ready"]
        ].filter(([count]) => count > 0).map(([count, status]) => div().h_full().flex_basis(0).flex_grow(count).bg(color(t, status))))))))
      .child(v_flex().id(`todos-list-${session?.session_id ?? "none"}`).flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8)
        .when(!session, el => el.child(div().p(4).whitespace_normal().text_color(t.muted).child(context?.message || "Focus a Pi terminal to see its Todos.")))
        .when(Boolean(this.feed.error), el => el.child(div().p(4).whitespace_normal().text_color(t.blocked).child(this.feed.error)))
        .when(Boolean(session) && !this.feed.error && !total, el => el.child(div().p(4).whitespace_normal().text_color(t.dim)
          .child(!this.feed.loaded ? "Loading Todos…" : "No Todos in this session yet. Ask Pi to make a plan.")))
        .children(group(NAMES.in_progress, active, "in_progress"))
        .children(group(NAMES.ready, ready, "ready"))
        .when(done.length > 0, el => el.child(h_flex().id("todos-completed").px(2).py(6).gap(6).items_center().cursor_pointer().text_size(11).text_color(t.dim)
          .on_click((_e, cx) => { this.showDone = !this.showDone; cx.notify(); })
          .child(svg(`mods/adam-todos/chevron-${this.showDone ? "down" : "right"}.svg`).size(11))
          .child(`Done · ${done.length}`)))
        .when(this.showDone, el => el.children(done.map(todo => this.todoRow(todo, t)))))
      .child(div().flex_none().px(14).py(10).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child("Read-only · updates through Pi’s Todo tool"));
  }
}
