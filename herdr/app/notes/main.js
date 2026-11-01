import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Textarea, TextareaState } from "gpui-base";
import { focused, terminals, spaces, props, theme, exec, readTextFile, writeTextFile, layout, window } from "herdr";
import { resolveSession } from "./session.js";
import { NoteDocument } from "./model.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}

export default class Notes extends View {
  init(_props, cx) {
    this.config = props(); this.documents = new Map(); this.key = null; this.message = "";
    cx.timer.every(750, cx => {
      for (const entry of this.documents.values()) {
        if (entry.doc.dirty && !entry.doc.busy && !entry.doc.error) cx.spawn(async cx => { const saving = entry.doc.save(); cx.notify(); await saving; cx.notify(); });
      }
      if (window()?.active !== false && !find(layout(), "panel")?.hidden && find(layout(), "panel-body")?.active === "notes") this.sync(cx);
    });
  }
  sync(cx) {
    const focus = focused(), context = resolveSession(focus, terminals());
    const space = spaces().find(space => space.id === focus?.space);
    const cwd = context.session?.cwd || focus?.cwd || space?.folder;
    const remote = context.on || space?.machine;
    const key = JSON.stringify([remote, cwd]);
    if (key === this.key) return;
    this.key = key; this.current = null;
    this.message = remote ? "Notes are local only for now." : !cwd ? "Focus a project to open its notes." : "Loading notes…";
    if (remote || !cwd) return;
    cx.spawn(async cx => {
      try {
        const result = await exec(this.config.node || "node", [this.config.reader, cwd]);
        if (result.code !== 0) throw new Error("Project unavailable");
        const project = JSON.parse(result.stdout);
        let entry = this.documents.get(project.path);
        if (!entry) {
          const draftKey = `draft:${project.path}`;
          const draft = JSON.parse(localStorage.getItem(draftKey) || "null");
          const doc = new NoteDocument(project.path, readTextFile, writeTextFile, draft, value => {
            if (value) localStorage.setItem(draftKey, JSON.stringify(value));
            else localStorage.removeItem(draftKey);
          });
          entry = { project, doc, state: null }; this.documents.set(project.path, entry);
          await doc.refresh();
        }
        if (this.key !== key) return;
        if (!entry.state) {
          entry.state = TextareaState.new({ value: entry.doc.text, placeholder: "Project notes, useful commands, things to remember…", rows: 20 });
          entry.state.on("change", (_event, cx) => { entry.doc.edit(entry.state.value()); cx.notify(); });
          entry.state.on("focus", (_event, cx) => { entry.focused = true; cx.notify(); });
          entry.state.on("blur", (_event, cx) => { entry.focused = false; cx.notify(); });
        }
        this.current = entry; this.message = "";
      } catch { if (this.key === key) this.message = "Could not open notes. Switch projects to retry."; }
      cx.notify();
    });
  }
  reload(entry, cx) {
    const { doc, state } = entry;
    if (doc.busy) return;
    doc.busy = true;
    cx.notify();
    const before = doc.text;
    cx.spawn(async cx => {
      // Keep the draft until a successful read; don't discard newer typing.
      try {
        const disk = await readTextFile(doc.path);
        if (doc.text !== before) return;
        doc.base = disk; doc.text = disk ?? ""; doc.error = ""; doc.loaded = true;
        doc.persist(null); state.set_value(doc.text);
      } catch { doc.error = "Could not reload. Draft retained."; }
      finally { doc.busy = false; cx.notify(); }
    });
  }
  async close() { await Promise.all([...this.documents.values()].map(entry => entry.doc.save())); }
  render(cx) {
    this.sync(cx);
    const t = theme(), entry = this.current;
    const root = v_flex().size_full().min_h(0).p(12).gap(10).bg(t.background).text_color(t.foreground).text_size(13);
    if (!entry) return root.child(div().whitespace_normal().child(this.message));
    const { doc, project, state } = entry;
    return root
      .child(h_flex().gap(4).items_center().flex_none()
        .child(div().flex_1().min_w(0).font_semibold().truncate().child(project.name))
        .child(Button.new("notes-save-status").size(26).flex_none().items_center().justify_center()
          .text_color(doc.error ? t.blocked : doc.busy || doc.dirty ? t.working : t.dim)
          .tooltip(doc.error || (doc.busy ? "Saving…" : doc.dirty ? "Unsaved changes…" : "Saved locally"))
          .child(svg(`mods/adam-notes/${doc.error ? "warning" : doc.busy ? "saving" : doc.dirty ? "dirty" : "saved"}.svg`).size(16)
            .when(doc.busy, icon => icon.spin(1000))))
        .child(Button.new("notes-reload").size(26).flex_none().items_center().justify_center().rounded(4).text_color(t.muted)
          .tooltip(doc.busy ? "Wait for saving to finish" : "Reload from disk (discards unsaved draft)")
          .when(!doc.busy, icon => icon.cursor_pointer().hover(style => style.bg(t.hover))
            .on_click((_event, cx) => { cx.stop_propagation(); this.reload(entry, cx); }))
          .child(svg("mods/adam-notes/reload.svg").size(16)))
        .child(Button.new("notes-folder").size(26).flex_none().items_center().justify_center().rounded(4).text_color(t.muted)
          .tooltip(this.copied === project.path ? "Notes-folder URL copied" : "Copy notes-folder URL")
          .cursor_pointer().hover(style => style.bg(t.hover))
          .on_click((_event, cx) => {
            cx.stop_propagation();
            const folder = project.path.slice(0, project.path.lastIndexOf("/") + 1);
            cx.write_to_clipboard("file://" + folder.split("/").map(segment => encodeURIComponent(segment)).join("/"));
            this.copied = project.path;
            const revision = this.copyRevision = (this.copyRevision || 0) + 1;
            cx.timer.after(1500, cx => {
              if (this.copyRevision !== revision) return;
              this.copied = null; cx.notify();
            });
            cx.notify();
          })
          .child(svg(`mods/adam-notes/${this.copied === project.path ? "saved" : "folder"}.svg`).size(16))))
      .child(v_flex().id("notes-editor").flex_1().min_h(0).w_full().rounded(6)
        .border_1().border_color(entry.focused ? t.accent : t.border).bg(t.surface).cursor_text()
        // Keep the enclosing layout from reclaiming keyboard focus for the terminal.
        .on_mouse_down("left", (_event, cx) => { state.focus(); cx.stop_propagation(); })
        .child(Textarea.new(state).flex_1().min_h(0).w_full().p(8).text_color(t.foreground)));
  }
}
