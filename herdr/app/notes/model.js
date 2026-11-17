// Ctrl-D uses the native replacement path (change events, selection, undo),
// not set_value(). UTF-16 selections must never split a surrogate pair.
export function deleteForward(state) {
  const value = state.value(), range = state.selected_range();
  const start = Math.min(range.start, range.end), end = Math.max(range.start, range.end);
  if (start === end) {
    if (start >= value.length) return;
    const character = String.fromCodePoint(value.codePointAt(start));
    const length = character === "\r" && value[start + 1] === "\n" ? 2 : character.length;
    state.set_selected_range({ start, end: start + length });
  }
  state.replace("");
}

// Markdown list helpers operate on raw text through the native replacement path.
// There is no read/edit mode: the note stays one plain, always-editable buffer.
const LIST_ITEM = /^([ \t]*)([-+*]|\d{1,9}[.)])( +)(\[[ xX]\] )?(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function lineBounds(text, offset) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const newline = text.indexOf("\n", offset);
  return { start, end: newline === -1 ? text.length : newline };
}

// Lists inside fenced code blocks are code, not Markdown.
function insideFence(text, lineStart) {
  let fence = null;
  for (const line of text.slice(0, lineStart).split("\n")) {
    const marker = FENCE.exec(line.replace(/\r$/, ""));
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
  }
  return fence !== null;
}

/** After the native Enter has inserted its newline: continue, outdent or end a list. */
export function continueList(state) {
  const text = state.value(), range = state.selected_range(), cursor = range.start;
  if (range.start !== range.end || cursor === 0 || text[cursor - 1] !== "\n") return false;
  const previousStart = text.lastIndexOf("\n", cursor - 2) + 1;
  if (insideFence(text, previousStart)) return false;
  const item = LIST_ITEM.exec(text.slice(previousStart, cursor - 1).replace(/\r$/, ""));
  if (!item) return false;
  const [, indent, marker, space, task, body] = item;
  const rest = text.slice(cursor, lineBounds(text, cursor).end);
  if (!body.trim() && !rest.trim()) {
    // Enter on an empty item: outdent a nested item, otherwise end the list.
    const outdented = indent.replace(/^(?: {1,2}|\t)/, "");
    state.set_selected_range({ start: previousStart, end: cursor });
    state.replace(indent ? `${outdented}${marker}${space}${task ? "[ ] " : ""}` : "");
    return true;
  }
  const next = /^\d/.test(marker) ? `${Number.parseInt(marker, 10) + 1}${marker.at(-1)}` : marker;
  state.replace(`${indent}${next}${space}${task ? "[ ] " : ""}`);
  return true;
}

/** Native Tab inserts its indent at the cursor. On a list item, move it to the line start. */
export function nestListAfterTab(previous, state) {
  const text = state.value(), range = state.selected_range(), cursor = range.start;
  if (range.start !== range.end) return false;
  const inserted = text.length - previous.length;
  if (inserted !== 2 && inserted !== 4 && inserted !== 1) return false;
  const indent = text.slice(cursor - inserted, cursor);
  if (!(indent === "  " || indent === "    " || indent === "\t")) return false;
  if (text.slice(0, cursor - inserted) + text.slice(cursor) !== previous) return false;
  const lineStart = text.lastIndexOf("\n", cursor - inserted - 1) + 1;
  const before = text.slice(lineStart, cursor - inserted);
  if (/^[ \t]*$/.test(before) || insideFence(text, lineStart)) return false;
  const line = previous.slice(lineStart, lineBounds(previous, lineStart).end);
  if (!LIST_ITEM.test(line.replace(/\r$/, ""))) return false;
  state.set_selected_range({ start: lineStart, end: cursor });
  state.replace(indent + before);
  return true;
}

// A document owns its asynchronous writes, even after focus moves elsewhere.
export class NoteDocument {
  constructor(path, read, write, draft = null, persist = () => {}) {
    this.path = path; this.read = read; this.write = write; this.persist = persist;
    this.base = draft?.base ?? null; this.text = draft?.text ?? "";
    this.recovered = draft !== null; this.loaded = false; this.busy = false; this.error = "";
  }
  get dirty() { return this.text !== (this.base ?? ""); }
  edit(text) { this.text = text; this.persist({ base: this.base, text }); }
  async refresh() {
    if (this.busy || (this.loaded && this.dirty)) return false;
    this.busy = true;
    const before = this.text;
    try {
      const disk = await this.read(this.path);
      if (this.text !== before) return false;
      if (this.recovered && disk !== this.base) {
        this.error = "File changed outside Herdr. Draft retained; copy it before reloading.";
      } else {
        this.base = disk;
        if (!this.recovered) this.text = disk ?? "";
        this.error = "";
      }
      this.recovered = false; this.loaded = true;
      return true;
    } catch { this.error = "Cannot read notes. Draft retained."; return false; }
    finally { this.busy = false; }
  }
  async save() {
    if (!this.loaded || this.busy || !this.dirty || this.error) return;
    const text = this.text;
    this.busy = true;
    try {
      await this.write(this.path, text, this.base);
      this.base = text;
      this.persist(this.dirty ? { base: this.base, text: this.text } : null);
    } catch { this.error = "Not saved: file changed or write failed. Draft retained. Copy it before reloading."; }
    finally { this.busy = false; }
  }
}
