import { View, div } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState } from "gpui-base";
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
        if (entry.doc.dirty && !entry.doc.busy && !entry.doc.error) cx.spawn(async cx => { await entry.doc.save(); cx.notify(); });
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
  async close() { await Promise.all([...this.documents.values()].map(entry => entry.doc.save())); }
  render(cx) {
    this.sync(cx);
    const t = theme(), entry = this.current;
    const root = v_flex().size_full().min_h(0).p(12).gap(10).bg(t.background).text_color(t.foreground).text_size(13);
    if (!entry) return root.child(div().whitespace_normal().child(this.message));
    const { doc, project, state } = entry;
    return root
      .child(h_flex().gap(8).items_center().child(div().font_semibold().child("Notes")).child(div().text_color(t.muted).truncate().child(project.name)))
      .child(div().text_size(10).text_color(t.dim).whitespace_normal().child(project.path))
      .child(v_flex().id("notes-editor").flex_1().min_h(0).w_full().rounded(6)
        .border_1().border_color(entry.focused ? t.accent : t.border).bg(t.surface).cursor_text()
        // Keep the enclosing layout from reclaiming keyboard focus for the terminal.
        .on_mouse_down("left", (_event, cx) => { state.focus(); cx.stop_propagation(); })
        .child(Textarea.new(state).flex_1().min_h(0).w_full().p(8).text_color(t.foreground)))
      .child(div().text_size(11).text_color(doc.error ? t.blocked : t.dim).whitespace_normal()
        .child(doc.error || (doc.busy ? "Saving…" : doc.dirty ? "Unsaved changes…" : "Saved locally")))
      .child(div().id("notes-reload").text_size(11).text_color(t.muted).cursor_pointer().child("Reload from disk (discard draft)")
        .on_click((_event, cx) => {
          if (doc.busy) return;
          doc.busy = true;
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
        }))
      .child(div().text_size(10).text_color(t.dim).child("Your notes · agents edit only when asked"));
  }
}
