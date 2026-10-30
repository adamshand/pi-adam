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
