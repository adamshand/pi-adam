# Native Herdr Mac app integration

## Source and installed files

- `features/herdr-app-todos.ts`: Pi lifecycle bridge, registered in `index.ts`.
- `todos/`: native GPUI Todos/Ideas mod, pure read models, icons, and model tests.
- `ideas/read-ideas.js`: one-shot Node adapter for safe Work reads; uses the existing Work client.
- `tabs/`: personal clone of Herdr 0.1.7's tabs mod, with a Tasks button added.
  It keeps Files/Changes preferences and the per-space panel selection behavior.
- Installed as `~/.config/herdr-app/mods/adam-todos` and `mods/adam-tabs`.
- Personal layout `~/.config/herdr-app/layouts/adam.json` points its tab bar at
  `adam-tabs` and includes a `todos` block in the existing `panel-body` stack.
  Shipped layouts/mods were not edited.

The panel uses the existing resizable right sidebar and its native theme colors.
The sidebar does not open itself. Click **Tasks** to toggle it; click a Todo title
to expand/collapse intent, progress, and checklists. The in-progress Todo starts
expanded. Done Todos are retained under a collapsed Done section.

Both Todo and Idea cards have a copy-reference icon. It copies the canonical ID
and title to the system clipboard (full Work IDs avoid cross-project ambiguity).
A checkmark confirms the copy until the pointer leaves. It never inserts text
into a terminal, sends a message, or changes item state.

## Ideas view

The panel has **Todos | Ideas** tabs. The choice persists, and Ideas never
contribute to Todo counts. Ideas follow the focused Pi session's project (using
its stable cwd), or the focused shell folder. Project resolution is identical
to the Todo/Idea tools: git root, `.pi/work.json`, known aliases, and otherwise
**Unassigned** — never the global inbox.

The Ideas view groups Work's active items into Inbox and Open, across all
sources (including Feedback Reports). Cards show the last-updated date/time and a small Work-link icon. Click a title
to expand Markdown. The folder header uses a home-relative path; import-provenance
footers are hidden in the display only, never removed from Work. No promotion, deletion, dismissal, or direct editing yet.

`IdeasFeed` first asks the Node adapter for the exact project's local cache
(without credentials or HTTP), then requests a fresh snapshot. Subsequent
refreshes happen every 30 seconds only while Ideas is visible and the app is
active. Refresh and stale/error markers are explicit, and stale items retain
their last-success timestamp. A new project clears the old project's items
immediately, with generation guards against late reads/errors.

The adapter calls `WorkClient.cachedList` and `listReadOnly`. Unlike the
existing tool/legacy-board `list` method, these methods **never flush the
outbox**, retry queued captures, or issue POST/PATCH/DELETE requests. They may
update local project/list caches. The footer reports queued/blocked counts
without sending them. Existing tools retain their original flushing behavior.

Work credentials are resolved inside the Node helper, through its environment
or the existing Keychain integration. No token is passed as a command argument,
saved in a UI file/label, or returned to the mod. The helper returns a versioned
JSON snapshot; its failure envelope contains no stack trace or environment.

The personal layout's `adam-todos` content configures local `ideas_reader`
and `node` props. The bridge also publishes these nonsecret paths for each Pi
session. Remote readers execute on their own machine; an unbound remote shell
shows a reconnect message rather than reading local data. Remote support is
unit-tested but has not been exercised on a real remote machine.

## Identity and reads

The bridge publishes one JSON label, `pi-adam.todos`:

```json
{
  "version": 1,
  "owner": "runtime UUID",
  "session_id": "Pi session UUID",
  "cwd": "/the/Pi/session/working/directory",
  "todo_path": "/the/Pi/session/working/directory/.pi/todos/session-UUID.json",
  "name": "optional session name",
  "ideas_reader": "/path/to/pi-adam/herdr/app/ideas/read-ideas.js",
  "node": "/path/to/node"
}
```

The UI validates the reference and the complete version-2 Todo plan, including
file/session ownership and duplicate IDs. It never scans for a recent session.
Shell `cd` doesn't change the session's Todo directory. A focused temporary
terminal replacement is respected; an unbound shell shows an explanatory empty
state instead of borrowing another session's plan.

Local file events refresh immediately. A 1.5-second visible-only fallback
handles atomic replacement, missing folders, and watcher recovery. Remote
references use `readTextFile(path, {on: machine})` at 5-second intervals while
visible, with no local fallback. Reads are skipped while the sidebar is hidden,
another panel is selected, or the app is inactive. No redraw for unchanged data.
Generation guards discard late reads/errors from a previously focused session.

Normal Pi startup, resume/new/fork/reload and session-name changes publish the
reference; ordinary agent starts retry failed startup publication. Headless Pi
doesn't publish. Shutdown checks ownership before removing the label. A process
crash can leave a stale label until the next Pi session publishes; the reference
is not a process liveness protocol.

The current already-running session was bootstrapped once from its known
`PI_SESSION_ID` and working directory so it could display the panel without
interrupting the run. `/reload` enables automatic lifecycle publishing/cleanup
in that session. Other existing Pi sessions need `/reload` once too.

## Refreshing installed source

From this repository:

```sh
cp herdr/app/todos/{main.js,model.js,ideas-model.js,ideas-view.js,ideas-format.js,references.js,copy-reference.js,copy.svg,mod.json,chevron-down.svg,chevron-right.svg,todos.svg,external-link.svg} ~/.config/herdr-app/mods/adam-todos/
cp herdr/app/tabs/{main.js,mod.json} ~/.config/herdr-app/mods/adam-tabs/
herdr-app check ~/.config/herdr-app/mods/adam-todos
herdr-app check ~/.config/herdr-app/mods/adam-tabs
herdr-app status
herdr-app shot /tmp/herdr-todos.png
```

For a fresh install, first read `herdr-app --skill` and its installed `AGENTS.md`.
Create personal copies rather than changing shipped layouts or mods. Copy the
source mods above, point the personal layout's tabs block at `adam-tabs`, and add
this child alongside Files and Changes in its `panel-body` stack:

```json
{
  "id": "todos", "type": "block",
  "content": {
    "mod": "adam-todos",
    "props": {
      "ideas_reader": "/absolute/path/to/pi-adam/herdr/app/ideas/read-ideas.js",
      "node": "node"
    }
  }
}
```

The current pre-Todos layout backup is
`~/.config/herdr-app/backups/todos-panel-20261030-111310/adam.json`.
Restoring that personal layout removes the integration from the visible UI;
the dormant mods and core label do not change Todo data.

## Native Pi footer

`status/` is a personal clone of Herdr 0.1.7's `workspace-status`, installed as
`mods/adam-status`; the `status` block in the personal `adam` layout uses it.
The shipped mod is unchanged. Without focused Pi metrics, its original machine,
branch, agent count and command hint remain. With Pi focused, its model,
thinking/Fast mode, speed, cost, context percentage and Codex limits appear.
Git counts show tracked staged + unstaged lines versus HEAD (`+ / −`) and commits
`↑ / ↓` versus the configured upstream (usually origin, using last-fetched refs;
no automatic fetch). Zero counts are omitted. They refresh at startup, branch
changes, turn completion and agent settlement, even with the Pi footer hidden.
Failed Git reads clear stale counts; missing upstream omits only commit counts.
Below 600 logical pixels Git counts remain in the complete metrics tooltip.
At narrower widths, secondary metrics move into the complete hover tooltip;
model/context remain. The machine/branch/agent summary yields space as needed.

Model, thinking and Fast are clickable after `/reload`:
- **Model** cycles the current session's scoped/configured rotation, filtering out
  unavailable models, or all authenticated models when no scope is configured.
  Explicit scoped thinking levels are honoured.
- **Thinking** cycles only levels supported by the selected model.
- **Fast** uses the same session-persisted toggle as `/fast`.

Controls are available only while Pi is idle, with no queued messages. These
changes affect this session, not global model/thinking defaults. Hover shows the
control action; unsupported actions remain ordinary text. Clicks capture the
exact terminal/runtime endpoint; switching focus cannot retarget a pending click.
Nothing types into the terminal, changes a draft, or sends a chat message.

`features/herdr-app-footer-controls.ts` owns a private per-runtime Unix socket
(directory mode 0700, socket 0600). The optional snapshot `controls` descriptor
provides its socket, runtime owner/session IDs, Node/client paths and capabilities.
The native mod executes `status/control-client.js` on that terminal's machine;
the timed helper sends one whitelisted action, never arbitrary code or text.
The server validates identity, serializes mutations and rechecks Pi's actual
idle state, rejects stale/busy requests, and sanitizes failures. It closes the
socket and removes the private directory at session shutdown/reload. Missing
endpoints show a reload notice, never fall back to terminal input. A crash may
leave an inert temporary socket directory. Windows controls are intentionally
not enabled until an equivalent protected transport exists. Remote invocation
is unit-tested but has not been live-tested on another machine.

`features/footer.ts` owns the metrics lifecycle for both renderers. Its
`HerdrFooterBridge` publishes version-1 `pi-adam.footer` JSON on that exact core
terminal. The payload contains a runtime owner UUID, session ID and display
metrics only: no transcript, credentials or raw diagnostic errors. Identical
metrics do not rewrite labels. Lifecycle events and usage/Fast changes update
the snapshot, never token-stream redraws. Core calls are serialized and bounded.

The native mod acknowledges each live Pi runtime with `pi-adam.footer-host`,
even when another pane is focused. Pi hides its terminal footer by rendering
zero lines only after receiving its own acknowledgement. HC terminals without
Herdr's tab label, missing native mods and failed publications keep the normal
Pi footer. Layout/connection changes are rechecked at the next lifecycle update;
there is no permanent bridge poll. On shutdown, each side removes only metadata
it still owns. A process/app crash can leave stale labels until the next runtime
or cleanup; this is not a process-liveness protocol.

The native view reads only the actual focused terminal (including replacements
and machine-qualified remote addresses), not the latest session or another pane.
It checks core state and the Pi report before showing metrics. Local and remote
focus isolation are unit-tested; live remote hosting has not been tested.
Existing Pi sessions need `/reload` once, while new sessions start automatically.
The active session's footer was visually verified in the running app; a separate
temporary preview publication was removed after testing.

Deploy/update after cloning `workspace-status` as `adam-status`:

```sh
cp herdr/app/status/{main.js,model.js,mod.json} ~/.config/herdr-app/mods/adam-status/
herdr-app check ~/.config/herdr-app/mods/adam-status
herdr-app status
herdr-app shot /tmp/herdr-pi-footer.png
```

Point the personal layout's `status` block at `adam-status`. Restoring its
original `workspace-status` mod disables the native metrics; Pi restores its
terminal footer on the next lifecycle update. The pre-footer layout backup is
`~/.config/herdr-app/backups/pi-footer-20261030-125615/adam.json`.
The pre-clickable installed mod backup is
`~/.config/herdr-app/backups/clickable-footer-20261030-131057/adam-status/`.

## Checks

`pnpm check` covers the Pi bridge and pure model, including:
two sessions sharing a directory; missing/malformed/dead references; remote and
Windows paths; owner mismatches and corrupt plans; nested checklist progress;
late reads/errors during focus changes; no redraw on unchanged content;
atomic file replacement without writes; shutdown ownership and retry behavior.

Ideas tests additionally verify GET-only reads with a queued capture left
byte-for-byte untouched; credential-free cache reads; project/unassigned
isolation; cold offline scope; cache-first loading; sanitized CLI output;
and late response/error isolation. The actual Work API returned the expected
project-scoped list, and the native view was checked against live data.

The pre-Ideas layout/mod backup is
`~/.config/herdr-app/backups/ideas-panel-20261030-112704/`.

Both installed mods must also pass `herdr-app check`. Live screenshots verified
the Todos button and this session's real Todo, progress bar, wrapped title,
progress text, and checklists. Remote reads and session replacement have unit
coverage; they were not exercised by switching the person's running sessions.
