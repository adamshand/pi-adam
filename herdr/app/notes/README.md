# Project notes

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

Autosave runs on a 750ms tick using Herdr's atomic expected-content writes. A local
recovery draft is persisted per document before saving. Writes remain bound to the
original document when focus changes. External edits reject a stale save rather than
being overwritten; copy your draft before using the explicitly destructive Reload
button. Reload also picks up external edits. App crashes/forced termination can still
interrupt the last keystroke. Remote projects intentionally show an unsupported message.

Install/update (back up personal layout/mods first):

```sh
mkdir -p ~/.config/herdr-app/mods/adam-notes
cp herdr/app/notes/{main.js,model.js,session.js,mod.json} ~/.config/herdr-app/mods/adam-notes/
cp herdr/app/tabs/main.js ~/.config/herdr-app/mods/adam-tabs/
herdr-app check ~/.config/herdr-app/mods/adam-notes
herdr-app check ~/.config/herdr-app/mods/adam-tabs
```

Add a `notes` block to the personal layout's `panel-body` stack, using `adam-notes`
and props `{ "reader": "/absolute/pi-adam/herdr/app/notes/project.js", "node": "/absolute/node" }`.
`session.js` is a deployment copy of `../todos/model.js`; keep it synchronized when
that label contract changes. No shipped mod or layout is modified.

Tests cover canonical/worktree identity, typing during writes, rejected stale writes,
recovered conflicting drafts, and late reads. Native checks and a live empty-editor
screenshot passed; real typing and cross-session UI switching still need user testing.
