# Project notes

The compact header shows the project name, save-state icon (including errors),
reload icon (discards unsaved draft), and copy-notes-folder-URL icon. All icons
have tooltips. No path or footer text takes space from the editor. The Files
panel has no reveal-folder command, so the folder icon copies a file:// URL.

Native local-only Notes panel. Files live at `~/.pi/projects/<name>-<identity-hash>/notes.md`.
The canonical Git common directory supplies identity, so subfolders and worktrees share
notes. Non-Git folders use their canonical absolute path. Separate clones are separate;
renaming/moving a repository changes its ID. This deliberately does not depend on Work
credentials, project lists or its shared Unassigned bucket.

Find the path for an agent or editor:

```sh
node herdr/app/notes/project.js /absolute/project/folder
```

These are **human-owned notes**. Agents may read them when asked, and should only
write when explicitly asked. No note content is automatically added to Pi prompts.
This is a convention, not a filesystem permission boundary.

Pi's `read_project_note({})` tool reads the saved note for `ctx.cwd`, using the same
canonical resolver without creating directories/files or flushing editor drafts.
It works without Herdr, returns a structured `{ project, path, exists, text,
truncated }` object (also in Codemode), and bounds output to 48 KiB/2000 lines. Use
`read` on the returned path for the rest. Missing and empty notes are distinct;
other I/O errors are reported. `/reload` once in Pi enables the new tool.

### Editing keys

**Ctrl-D** deletes the next character or selection, including a newline at the
start of an empty line (joining it with the following line). At end of the file
it does nothing. This is scoped to the focused Notes editor, uses the native
replacement/change/undo path, and never sends Ctrl-D to the terminal. Existing
Ctrl-A/E and other native shortcuts are unchanged. A complete readline keymap
would need word/kill/yank semantics, so only the missing Ctrl-D was added.

**Lists** stay plain Markdown text in the single always-editable note (no read/edit
modes). Enter continues `-`/`*`/`+`, numbered (`9.` → `10.`) and task (`- [ ]`)
items at the same indentation; Enter on an empty item outdents a nested item, or
ends a top-level list. Shift-Enter inserts a plain newline. Tab anywhere in a list
item nests the whole item; Shift-Tab (native) outdents. Fenced code is ignored.
Native Enter inserts the newline before Notes adds the marker, so undo can take
two steps.

Autosave runs on a 750ms tick using Herdr's atomic expected-content writes. A local
recovery draft is persisted per document before saving. Writes remain bound to the
original document when focus changes. External edits reject a stale save rather than
being overwritten; copy your draft before using the explicitly destructive Reload
button. Reload also picks up external edits. App crashes/forced termination can still
interrupt the last keystroke. Remote projects intentionally show an unsupported message.

Install/update (back up personal layout/mods first):

```sh
mkdir -p ~/.config/herdr-app/mods/adam-notes
cp herdr/app/notes/{main.js,model.js,session.js,mod.json,*.svg} ~/.config/herdr-app/mods/adam-notes/
cp herdr/app/tabs/main.js ~/.config/herdr-app/mods/adam-tabs/
herdr-app check ~/.config/herdr-app/mods/adam-notes
herdr-app check ~/.config/herdr-app/mods/adam-tabs
```

Add a `notes` block to the personal layout's `panel-body` stack, using `adam-notes`
and props `{ "reader": "/absolute/pi-adam/herdr/app/notes/project.js", "node": "/absolute/node" }`.
`session.js` is a deployment copy of `../todos/model.js`; keep it synchronized when
that label contract changes. No shipped mod or layout is modified.

Tests cover canonical/worktree identity, typing during writes, rejected stale writes,
recovered conflicting drafts, late reads, and Ctrl-D selection/empty-line/UTF-16
behavior. Pi tool tests cover no-create reads, saved content, missing vs empty,
output bounds and cancellation. `resolveProjectNotes` is read-only; only the
panel's `projectNotes` entry point creates its private directory. Native checks and a live empty-editor
screenshot passed; real typing and cross-session UI switching still need user testing.
