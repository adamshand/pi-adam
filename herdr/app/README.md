# Native Herdr Mac app integration

Current source targets **herdr-app 0.1.16+** (`checking()` and cancellable folder
watches). See [`../RELEASE-REVIEWS.md`](../RELEASE-REVIEWS.md) for the app/core
release review baseline, adopted fixes, retained naming/recovery behavior, and
the source-only deployment boundary. Our custom mods are not updated by Herdr.

## Footer hover and background refresh

Notes and Status changes were deployed to the installed personal mods on
2026-11-16 (main/model files only; no layout or other mod changes). Backup:
`~/.config/herdr-app/backups/notes-footer-live.X5Ycrz/`. Both installed native
checks pass and app status reports no errors. Restarting Herdr alone does not
copy repo source into installed mods; future UI changes need explicit deployment.
Keyboard behavior and hover content still require a human live check.

The personal Status mod's hover gives supplemental quota detail rather than
repeating visible metrics: 5-hour/weekly reset date/time in local time with a
relative duration, plus banked reset expiry details where the API supplies them.
Individual quota/reset metrics have their own corresponding hover. Missing and
partial expiry detail is explicit; count is authoritative, null means an explicitly
non-expiring credit. These fields use the existing credits GET request; no new
poller, redemption action, credit ID or profile metadata is added.

The intermittent right-side widening had a deterministic cause: every periodic
quota refresh appended `…` to each populated quota label, then removed it on
completion. Known values now keep identical text/layout during loading; the
refresh state moves to hover. Initial loading and stale/error indicators remain.
This was covered by a ready/loading/ready regression, not a live visual reproduction.

## Source and installed files

- `features/herdr-app-todos.ts`: Pi lifecycle bridge, registered in `index.ts`.
- `todos/`: native GPUI Todos/Ideas mod, pure read models, icons, and model tests.
- `ideas/read-ideas.js`: one-shot Node adapter for safe Work reads; uses the existing Work client.
- `tabs/`: personal clone of Herdr 0.1.7's tabs mod, with Tasks/Notes buttons
  and selected 0.1.15/0.1.16 fixes: active-tab reveal, smooth-scroll throttling,
  live-title fallback and resilient saved state. It keeps Files/Changes preferences
  and the per-space panel selection behavior.
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
`features/footer-git-watch.ts` also watches the session's local Git directory and
common directory, coalescing metadata changes for 400ms. Commits/staging/checkout
and fetch therefore refresh footer counts without an agent turn. No idle polling
is added; object/reflog/lock noise is ignored. Watchers close at shutdown/reload.
Existing sessions need `/reload` to enable this; unsupported watchers retain the
normal lifecycle refreshes.
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
cp herdr/app/status/{main.js,model.js,focus.js,mod.json} ~/.config/herdr-app/mods/adam-status/
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

## Idle focus coverage

The updated `adam-status` reports local terminal focus using `focused().shown || focused().terminal` plus `window().active`. It requires the updated Pi footer endpoint (`controls.focusSpans`) and `status/focus.js` alongside the installed mod. The helper remains at the repository path advertised by Pi. Deploy the status files using the command above, check the mod, then reload Pi. This implementation has not been installed into live mods by the implementation task.

Only tracking sessions subscribe. Focus transitions or a changed Pi checkpoint epoch close the previous observation span; unrelated renders never launch a focus helper. Tracking/activity changes publish the descriptor directly, while incoming coverage never publishes another checkpoint. Unsubscribing can flush one final closed span. A bounded per-runtime queue delivers it over the existing private Unix socket, with runtime/session identity checks, strict schema validation, ordered sequence numbers, a 5-second maximum delivery age and 6-second helper deadline. At most 32 spans queue behind an in-flight request; overflow or failure leaves a coverage gap. There are no idle timers and no focus extrapolation. Unconfirmed tails remain unknown even when the last observation said unfocused. Confirmed focus spans are intersected with Pi's waiting/working transitions and billable intervals, stored at millisecond precision, and coalesced when adjacent classifications match.

A dead/removed provider never extends its last report. Providers carry a start timestamp and unique identity, ordered as a generation tuple. A newer generation takes over after the last covered end, with no extrapolation through the disconnected gap. A single high-water generation rejects retired messages without unbounded history. Use one app window and one status-mod copy for these sessions; simultaneous clients are unsupported. Remote panes are excluded. Mod hot reload and app restart establish a new baseline without requiring Pi reload. A backwards system-clock change may delay handoff until timestamps catch up. Sleep is not independently detected. Render timestamps approximate native focus transitions; this is not an OS-level attention tracker.

Standard Pi extension prompt events are supported; custom screens can be loaders and are excluded, as are arbitrary tool/terminal waits. A turn stamp contains only coverage confirmed when that stamp was written, so later delivery can increase `/track status` without changing the earlier stamp. Clear confirmation ignores telemetry/checkpoint revisions while retaining semantic revision and session/owner checks, and archives the latest delivered coverage atomically. Empty coverage intersections never write the ledger. Old ledgers and stamps remain readable; unmeasured time is shown as unknown rather than idle or active.

Before deployment, run `pnpm check` and `herdr-app check "$PWD/herdr/app/status"` outside a restricted sandbox, then review in a separate test Pi session with a temporary ledger. Verify tab changes, terminal replacements, app activation, mod removal/restart, and pause/clear/reload. No live focus or installed-layout changes were made during implementation.
