# pi-adam

Personal pi quality-of-life extension.

## Features

- Slash-command autocomplete is sorted by most recently used commands.
- Compact custom footer keeps model and thinking level on the left, with cost, context usage, and Codex limits right-aligned.
- Loads dotenv-style variables from `~/.pi/env`, then trusted project `.pi/env` files. Existing shell variables take precedence.
- `/env` lists variables declared by those files with values redacted.
- `/codex-usage` shows Codex usage, reset times, and available banked resets; `/codex-usage-refresh` refreshes it immediately.
- Slash-command usage is stored in `state.json` next to this extension.
- `/pi-adam-mru` shows the recent list.
- `/pi-adam-mru reset` clears it.
- Inside Herdr, Pi `/name` values automatically rename the tab and appear beneath the workspace name in the agents panel.
- Herdr todo board watches `.pi/todos` and shows session or project progress in a side pane.
- New todos are scoped to the current Pi session automatically; add a `project` tag to keep a todo project-wide.

## Herdr session names

When Pi runs inside Herdr, `/name bugs` renames the current tab and reports `bugs` as the visible agent label. This package expects the following Herdr sidebar layout in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace"], ["agent"]]
```

The resulting agent entry is:

```text
pi-adam.git
bugs
```

Reload Herdr configuration with `herdr server reload-config` after changing it. Clearing the Pi session name restores the tab's numeric label and the normal `pi` agent label.

## Herdr todo board

The feature has two small entrypoints: `features/herdr-todos.ts` knows Pi's session and tool lifecycle, while `herdr-plugin/` owns the independent terminal pane. Both use `herdr-plugin/todo-store.js` as their only todo storage implementation.

Link the local Herdr plugin once during development:

```bash
herdr plugin link "$PWD/herdr-plugin"
```

By default, the board opens automatically at roughly one-third of the tab width while its actionable view has unfinished todos. Session ownership is stored as a hidden `session:<pi-session-id>` tag, so separate Pi sessions in the same checkout get separate boards and task lists. The board has three views:

- **SESSION** — actionable todos owned by the current Pi session.
- **ALL** — every actionable todo in the checkout.
- **IDEAS** — project-wide future possibilities that are not current commitments.

```text
/herdr-todos view session
/herdr-todos view all
/herdr-todos view ideas
```

Capture actionable todos or non-actionable ideas manually from Pi. Omitting a title opens an input prompt:

```text
/todo Buy milk
/todo --project Fix release workflow
/idea Explore a future project
```

Ideas are stored independently under `.pi/ideas/<id>.md` with creation/update timestamps, the originating Pi session ID, and whether they were captured by the user or agent. They do not count as unfinished and do not automatically open the pane. The agent-facing `idea` tool can create, list, update, delete, and promote ideas.

The extension guides agents to maintain a small set of outcome-level commitments instead of one opaque umbrella ticket or many mechanical micro-tasks. It explicitly distinguishes actionable todos from future ideas and reminds agents to reconcile both before settling.

Press `Alt+T` while the Pi pane is focused to toggle the Herdr board. The equivalent visibility and maintenance commands are:

```text
/herdr-todos toggle   # manually show or hide for this running session
/herdr-todos auto     # restore automatic visibility
/herdr-todos clear    # confirm, then delete completed todos in the current scope
/herdr-todos status
/herdr-todos refresh
```

In the board, click a status icon or select a row with `↑`/`↓` or `j`/`k` and press Space to cycle:

```text
○ outstanding → ◐ in progress → ✓ done → ○ outstanding
```

Markdown checklist progress appears beside each title, such as `2/4`. Press `d` or click a todo's title to expand or collapse its context and checklist; click its status icon to cycle status.

Press `Tab` to cycle `SESSION → ALL → IDEAS`, click a header label directly, or press `i` to toggle Ideas and the previous todo view. In Ideas, press `p` to promote the selected item into a current-session todo or `x` to dismiss it with confirmation. Automatic opening restores the last actionable view rather than opening into Ideas.

Press `c` to clear completed todos in SESSION or ALL (with confirmation), or `q` to close the pane. IDs, session tags, and category tags are intentionally hidden. The board polls `.pi/todos` every 700ms, so tool and board changes stay synchronized.

To open the plugin pane manually from a Pi pane:

```bash
herdr plugin pane open \
  --plugin pi-adam.todos \
  --entrypoint board \
  --placement split \
  --direction right \
  --env "PI_ADAM_TODO_CWD=$PWD" \
  --env "PI_ADAM_TODO_SESSION_ID=$PI_SESSION_ID" \
  --env "PI_ADAM_TODO_VIEW=session" \
  --no-focus
```

Do not pass `--cwd`: Herdr normally runs the command from the plugin root, where `board.js` lives.

## Structure

`index.ts` composes small, independent feature modules:

- `features/env.ts` — dotenv loading and `/env`
- `features/footer.ts` — custom session footer
- `features/codex-usage.ts` — read-only Codex usage and banked-reset API integration
- `features/herdr-session-name.ts` — Pi `/name` synchronization with Herdr tabs and agent titles
- `features/herdr-todos.ts` — todo/idea guidance and tools, board lifecycle, views, and visibility
- `features/mru.ts` — slash-command recency and editor integration
- `herdr-plugin/board.js` — interactive terminal board
- `herdr-plugin/todo-store.js` — actionable todo persistence and transitions
- `herdr-plugin/idea-store.js` — non-actionable idea persistence and promotion
- `herdr-plugin/view-state.js` — session-local board view state
- `herdr-plugin/herdr-plugin.toml` — Herdr plugin manifest

Reload pi with `/reload` after changes.
