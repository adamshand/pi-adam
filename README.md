# pi-adam

Personal pi quality-of-life extension.

## Features

- Slash-command autocomplete is sorted by most recently used commands.
- Compact custom footer keeps model, thinking level, and active Codex Fast mode on the left, with cost, context usage, and Codex limits right-aligned. Git stats (`+142 −38 ↑2 ↓3`) sit centered where space permits; zero counts are hidden. Line counts are net tracked-file changes versus HEAD (staged and unstaged; excludes untracked and binary files). Arrows compare against the configured upstream as of the last fetch; the footer never fetches. Stats refresh asynchronously at startup, branch changes, turn completion, and settlement; unavailable Git/HEAD or insufficient space hides the group.
- `/fast` toggles Fast mode for supported GPT-5.4–5.6 Codex models using ChatGPT OAuth; `alt+shift+tab` does the same.
- `codex_image` generates and saves images through Codex's native `gpt-image-2` hosted tool.
- Codemode's `save_image` saves image blocks from built-in image models as local artifacts without shell/base64 plumbing.
- Bundles a pinned `agent-browser` CLI and loads its current core skill on demand for headless application testing.
- Gives every Pi session isolated browser state, bounded output, and a 15-minute idle-cleanup backstop.
- Adds Pi-specific orchestration guidance for parallel Luna scouts and fresh Kimi/Grok change reviews through `pi-subagents`.
- Adds a dim, right-aligned local completion timestamp after each final settled agent response.
- Loads dotenv-style variables from `~/.pi/env`, then trusted project `.pi/env` files. Existing shell variables take precedence.
- `/env` lists variables declared by those files with values redacted.
- `/codex-usage` shows Codex usage, reset times, and available banked resets; `/codex-usage-refresh` refreshes it immediately.
- `/pi-adam-status` reports model, Fast injection, usage freshness/errors, image eligibility, footer cost, and context diagnostics.
- Slash-command usage is stored in `state.json` next to this extension.
- `/pi-adam-mru` shows the recent list; `/pi-adam-mru reset` clears it.
- Inside Herdr, Pi `/name` values automatically rename the tab and appear in the agents panel.
- Herdr agent rows can show each Pi pane's Git branch, working-tree changes, and upstream divergence through custom metadata tokens.
- The work ledger keeps current-session Todos visible in a Herdr pane while retaining project-wide Ideas for later.
- One-shot session timers wake the agent without polling, surviving reload and session resume.

## Codemode-friendly tools

`todo` and `idea` return structured `{ action, items }` results in Codemode. Lists always return an array (including `[]`). Ideas are backed by Work; check `stale`, `queued`, `blocked`, `error`, and `outbox` before treating an operation as settled. A queued capture has a UUID `key`, not a fabricated Work ID. Other failures reject. Direct calls retain readable JSON output.

```js
const { items } = await tools.todo({ action: "list" });
text(items.map(({ id, title, status }) => ({ id, title, status })));
```

`codex_image` saves an image and returns metadata including `outputPath`, `mimeType`, `model`, `imageModel`, and requested `size`. It no longer attaches an image by default. Set `preview: true` for a direct-call image attachment, or read the saved path separately to inspect selected results. Codemode receives metadata only, even with `preview: true`; do not regenerate an image just to inspect it.

```js
const artifact = await tools.codex_image({
  prompt: "A red fox in the snow, watercolor",
  size: "1024x1024",
  "target-path": "./images",
});
text({ path: artifact.outputPath, mimeType: artifact.mimeType });
```

For Pi's built-in `models.generateImages()`, use the Codemode-exposed `save_image` tool to save image blocks without sending base64 through shell arguments or model context. It returns `outputPath`, `mimeType`, `bytes`, and actual `width`/`height`. Files get unique names and are never overwritten. PNG, JPEG, WebP, and GIF headers are supported, up to 20 MiB decoded per image; this checks headers, not full image integrity. Relative destination directories resolve against the session cwd; omitted destinations use a temporary `pi-image-artifacts` directory. Use a project directory for durable artifacts.

```js
const result = await models.generateImages(
  { provider: "openrouter", id: "google/gemini-2.5-flash-image" },
  { input: [{ type: "text", text: "A red fox in the snow, watercolor" }] },
);
// Preserve usage and generation errors even if saving fails later.
text({ model: result.model, stopReason: result.stopReason, usage: result.usage, error: result.errorMessage });
if (result.stopReason !== "stop") exit();
const saves = await Promise.allSettled(
  result.output.filter(block => block.type === "image")
    .map(block => tools.save_image({ image: block, "target-path": "./images" })),
);
for (const saved of saves) {
  text(saved.status === "fulfilled" ? saved.value : { saveError: String(saved.reason) });
}
```

Inspect selected saved paths with `read`; no regeneration is needed. `save_image` makes no model calls and does not change Pi's provider routing or usage accounting. If saving fails, retry saving the same block within the script rather than paying to regenerate it. Large base64 arguments are omitted from Pi's bounded nested-call history, but tools and extension hooks still receive them: this is context minimization, not secret storage.

Filter bulky intermediate results before printing; keep errors and artifact paths visible. Use `Promise.allSettled()` for independent work, but await dependent mutations in order. Never print/store image base64. Codemode calls perform real side effects and are not rolled back when a later step fails. Existing tool exposure, native compaction, and durable timer behavior are unchanged; the new `save_image` is exposed through Codemode only.

## Agent-requested compaction

`request_compaction({})` queues Pi's existing compaction process for the end of the agent's response. The tool recommends considering compaction after finishing a job with context usage over 50%; this is guidance, not an enforced threshold. Each model request receives a small, non-persisted context-usage hint.

The agent can deliver its final response before compaction starts. Duplicate requests coalesce, queued work delays compaction, and an intervening successful compaction satisfies the request. Aborted/failed runs and session changes discard pending requests. No summary instructions, provider selection, or automatic compaction settings are changed.

## Timers

The agent-facing `timer` tool schedules a wake-up and returns immediately:

```js
timer({ action: "set", after: "33m", message: "Check that the token has expired." })
timer({ action: "set", at: "2026-10-03T11:13:00Z", message: "Resume the test." })
timer({ action: "set", at: "2026-10-03T21:33:00+13:00", message: "Resume at NZDT time." })
timer({ action: "list" })
timer({ action: "cancel", id: "<timer-id>" })
```

Durations accept `s`, `m`, `h`, or `d`, including decimals. Absolute times require a full date, seconds, and `Z` or an explicit UTC offset; invalid or past deadlines are rejected. The agent should finish its turn after scheduling rather than poll. A wake-up triggers a new turn when idle or queues a follow-up when busy, carrying the saved instructions and scheduled/actual times. Timers due together are delivered together.

Use `/timers` to inspect pending timers, `/timers cancel <id>` to cancel one, or `/timers cancel all` to cancel every pending timer. Timers belong to the session across conversation branches; cancellation or firing is not undone by tree navigation. Reload restores deadlines. Closing or switching sessions clears live callbacks; resuming the original session delivers overdue timers once.

Pi must remain running for on-time delivery. Timers do not launch Pi or wake a sleeping computer, and print-mode invocations should not be used as background schedulers. No model requests are made while waiting by the timer feature. Pending timers are consumed before queuing a wake-up to avoid duplicate delivery; a process crash during dispatch can lose that wake-up.

## Herdr agent metadata

When Pi runs inside Herdr, `/name bugs` renames the current tab. Pi also reports the repository at its session working directory as the custom Agent tokens `$branch` and `$git_status`. The latter renders compact values such as `!3 ?2 ↑1 ↓4`: `!` counts distinct changed tracked files (staged, unstaged, or conflicted), `?` counts untracked files, and the arrows show upstream ahead/behind commits. Zero-value parts disappear, and the whole token disappears for a clean branch synchronized with its upstream.

For example, show the session name with its per-agent Git context using this layout in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  ["$branch", "$git_status"],
]
```

Git metadata is refreshed when a session starts or settles and every five seconds while it remains open. Outside a Git checkout both values are cleared; on a detached HEAD only `$branch` is cleared, while working-tree counts remain available. Reload Herdr configuration with `herdr server reload-config` after changing it. Clearing the Pi session name restores the tab's numeric label.

## Todos and Ideas

- **Todos** stay local in **one file per session**, `.pi/todos/<session-id>.json`, with status `ready`, `in_progress`, or `done`. Each file contains the session's complete plan: Todo IDs, intent, progress, checklists, and Work links.
- **Ideas** live in [Work](https://work.haume.nz). The Ideas view includes this project's `inbox` and `open` items from every source, including feedback. Use the `work-triage` skill for bulk triage.

Promoting opens the Work item with a session comment and creates a linked local Todo. Repeating promotion in that session reuses the Todo. Completing a linked Todo offers to mark Work done; it never silently closes it. In headless use the tool returns an offer; after user approval, repeat `complete` with `sync_work: true`. Deferring returns linked Work to `inbox`, or captures an unlinked Todo in Work. The local Todo remains until Work confirms receipt. Dismissing an Idea sets `dropped` with a comment; deleting/clearing local Todos does not change Work.

Capture work directly from Pi:

```text
/todo Implement this in the current session
/idea Review this approach later
/todos
```

Omitting a title from `/todo` or `/idea` opens an input prompt. `/idea` captures with source `idea`; agent captures use `agent`. IDs are `IDEA-<last six hex>` or full `work_<24 hex>` IDs. Ambiguous short IDs and stale-list mutation lookups are rejected. Intent and checklists become Markdown; updates add/replace Pi-managed sections without overwriting unrelated feedback or import provenance.

### Work configuration and recovery

- Auth: `WORK_API_TOKEN`, then `HAUME_WORK_API_TOKEN`, then macOS Keychain service `work.haume.nz`. Tokens stay in memory. `WORK_URL` defaults to `https://work.haume.nz`.
- Project: git root's `.pi/work.json` (`{"project":"slug"}`, or `null` for unassigned), otherwise repository basename without `.git`, with aliases for imported projects such as `made` → `haume-made`. Unmatched repositories show **unassigned** items, not the global inbox.
- HTTP requests time out after 5 seconds. Session startup does not wait for Work. Lists cache locally and show `STALE` on failure.
- Creates are durably queued before sending in `~/.local/state/pi-adam/work-outbox.jsonl` (`$XDG_STATE_HOME/pi-adam` when set). A UUID `Idempotency-Key` and frozen payload make lost-response retries safe. Successful results are retained as receipt files so deferred Todos can finish safely after restart.
- Lists and successful mutations flush queued captures. Authentication/validation failures remain blocked, rather than retrying endlessly. After fixing the cause, use `/work-outbox retry` (or `r` in Herdr). Never change the frozen payload of a possibly delivered capture; investigate a conflict before replacing it.
- Outbox writes use a cross-process lock. If a process crashes with a lock held, verify the PID in `work-outbox.lock/owner.json` has exited before manually removing that lock directory. Locks are not automatically stolen.

On startup, existing per-Todo `.pi/work-items/*.json` and legacy Todo Markdown are consolidated into session files, preserving IDs, ownership, timestamps, and Work links. Source Todo files are removed only after their contents are saved; conflicting records are retained and reported rather than overwritten. Old Todos without an owner are kept separately in `.pi/todos/_unowned.json` without inventing session ownership. Ideas live exclusively in Work. The one-off Idea migration is finished: there is no startup import, provenance check, or legacy Idea migration script. Any old Idea files in other checkouts are ignored; Todo migration does not delete them.

Todo writes use atomic replacement and a short cross-process `.pi/todos.lock` to serialize updates from Pi and Herdr. If a writer crashes, verify the PID in `todos.lock/owner.json` has exited before removing the lock directory. Malformed plans and stale full-item writes are rejected, not overwritten.

There is **no automatic cleanup** on exit, startup, completion, or by age. Completed Todos remain available for review/reopening. `/todos clear` still removes only completed Todos from the current session after confirmation, leaving other sessions alone. Empty session files are retained too; cleanup policy is a separate decision.

## Herdr board

Link the local Herdr plugin once during development:

```bash
herdr plugin link "$PWD/herdr/todos"
```

The stable plugin ID remains `pi-adam.todos`. The board opens automatically at roughly one-third of the tab width while the current session has unfinished Todos. Ideas never open it automatically. The board has two views:

```text
Todos | Ideas
```

Use `Tab` or the clickable labels to switch views. The Pi command controls the pane:

```text
/todos                  # open the board
/todos toggle           # manually show or hide it
/todos auto             # restore automatic visibility
/todos view todos
/todos view ideas
/todos clear            # delete completed current-session Todos after confirmation
/todos status
/todos refresh
```

`Alt+T` toggles the board while the Pi pane is focused.

The header bar is segmented by state: green for done, amber for in progress, and grey for ready. Titles wrap instead of truncating. The Ideas view refreshes from Work every 30 seconds while visible, shows cache/outbox status, and uses the same promote/defer/drop logic as the tools. Configure credentials in Herdr's environment or Keychain too; secrets are never passed as process arguments.

Mouse controls are deliberately direct: single-click selects, double-click opens or closes focused detail, clicking `Todos` or `Ideas` changes view, clicking a Todo icon cycles its state, and the wheel scrolls focused detail. In Idea details, click **Open in Work ↗** to open that ticket in your default browser (the terminal's native hyperlink gesture also works).

Keyboard controls are limited to:

- `↑`/`↓` — select an item; scroll focused detail
- `←`/`→` — move a Todo one bounded state step: `ready ↔ in progress ↔ done`
- Enter — open or close focused detail
- `Esc` — close focused detail or help
- `?` — show or hide the controls reference
- `Tab` — toggle views
- `k` — promote/defer via Work and follow the item into its new view
- `r` — refresh Work and retry the outbox, including blocked captures
- `Delete` — delete a local Todo or drop a Work Idea after confirmation
- `c` — clear all done Todos after confirmation
- `q` — close the pane

The Todo footer stays minimal: `[?] help  [alt-t] show/hide`; Ideas show Work/stale/outbox status. For deletion, clearing, and linked Work completion, `y` confirms and any other key cancels. `Alt+T` opens the board from Pi and hides it from the board pane. `Alt+Shift+Tab` toggles Codex Fast mode.

To open the plugin pane manually from a Pi pane:

```bash
herdr plugin pane open \
  --plugin pi-adam.todos \
  --entrypoint board \
  --placement split \
  --direction right \
  --env "PI_ADAM_TODO_CWD=$PWD" \
  --env "PI_ADAM_TODO_SESSION_ID=$PI_SESSION_ID" \
  --env "PI_ADAM_TODO_VIEW=todos" \
  --no-focus
```

Do not pass `--cwd`: Herdr runs the command from the plugin root, where `board.js` lives.

## Agent browser

The `agent-browser` skill provides a compact command guide and points to the version-matched CLI documentation for deeper workflows.

Browser sessions are headless by default and isolated using the current Pi session ID.

Pi-adam closes an active owned browser during quit or session replacement while preserving it across `/reload`.

Use an explicit `--session` with `--restore` or `--profile` only when browser state should persist deliberately.

## Orchestration

The `orchestrate` skill complements the pinned user-level `pi-subagents` package. Substantive tasks can fan out up to three fresh, read-only Luna scouts before implementation. After meaningful code changes and local checks, the coordinator runs independent fresh-context Kimi and Grok reviewers in parallel, verifies their findings, and keeps implementation and approvals in the parent session.

Children cannot delegate, ambient extensions are disabled, and run artifacts stay in Pi's session storage. The orchestration policy does not use writing workers during the initial experiment; the automatic watchdog, schedules, and `pi-intercom` remain disabled.

Use `/review-changes <goal and acceptance criteria>` to request the dual review explicitly.

## Structure

`index.ts` composes small feature modules:

- `features/agent-browser.ts` — pinned CLI environment, dynamic skill, session isolation, and cleanup
- `skills/agent-browser/SKILL.md` — version-matched browser skill bootstrap
- `skills/orchestrate/SKILL.md` — bounded scout and dual-review coordination policy
- `features/compaction.ts` — agent-requested compaction at a completed-run boundary
- `features/env.ts` — dotenv loading and `/env`
- `features/footer.ts` — custom session footer
- `features/codex-fast.ts` — guarded, session-persisted Codex Fast mode
- `features/codex-image.ts` — Codex-hosted image generation and file saving
- `features/codex-image-utils.ts` — completed-image payload and SSE parsing helpers
- `features/save-image.ts` — Codemode image-block persistence with metadata-only results
- `features/codex-usage.ts` — lifecycle-safe Codex usage and banked-reset API integration
- `features/diagnostics.ts` — bounded, secret-redacting provider diagnostics
- `features/herdr-git-metadata.ts` — per-pane Git branch, working-tree, and upstream status for Herdr Agent tokens
- `features/herdr-session-name.ts` — Pi `/name` synchronization with Herdr tab titles
- `features/todos.ts` — canonical Todo/Idea tools, commands, guidance, and legacy migration
- `features/herdr-todos.ts` — Herdr board lifecycle, visibility, metadata, and `/todos`
- `features/mru.ts` — slash-command recency and editor integration
- `features/turn-stamp.ts` — final-response completion timestamps in the transcript
- `features/timers.ts` — persistent one-shot agent wake-ups, `timer`, and `/timers`
- `herdr/todos/board.js` — interactive Herdr board
- `herdr/todos/work-item-store.js` — unified persistence, lifecycle transitions, provenance, and legacy migration
- `herdr/todos/view-state.js` — session-local board view state
- `herdr/todos/herdr-plugin.toml` — Herdr plugin manifest

Reload Pi with `/reload` after changes. Because the Herdr plugin path moved, relink it once with the command above.
