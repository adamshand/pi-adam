# pi-adam

Personal pi quality-of-life extension.

## Features

- Slash-command autocomplete is sorted by most recently used commands.
- Custom footer shows token totals, cost, context usage, response speed, Codex 5-hour/weekly usage and banked resets, model, thinking level, and git branch.
- Loads dotenv-style variables from `~/.pi/env`, then trusted project `.pi/env` files. Existing shell variables take precedence.
- `/env` lists variables declared by those files with values redacted.
- `/codex-usage` shows Codex usage, reset times, and available banked resets; `/codex-usage-refresh` refreshes it immediately.
- Slash-command usage is stored in `state.json` next to this extension.
- `/pi-adam-mru` shows the recent list.
- `/pi-adam-mru reset` clears it.
- Herdr todo board watches `.pi/todos` and shows session or project progress in a side pane.
- New todos are scoped to the current Pi session automatically; add a `project` tag to keep a todo project-wide.

## Herdr todo board

The feature has two small entrypoints: `features/herdr-todos.ts` knows Pi's session and tool lifecycle, while `herdr-plugin/` owns the independent terminal pane. Both use `herdr-plugin/todo-store.js` as their only todo storage implementation.

Link the local Herdr plugin once during development:

```bash
herdr plugin link "$PWD/herdr-plugin"
```

By default, the board uses **session scope** and opens automatically while that session has unfinished todos. Session ownership is stored as a hidden `session:<pi-session-id>` tag, so separate Pi sessions in the same checkout get separate boards and task lists. Switch to all todos in the checkout with project scope:

```text
/herdr-todos scope session
/herdr-todos scope project
```

Visibility and maintenance commands:

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

Press `c` to clear completed todos in the board's current scope (with confirmation), or `q` to close the pane. IDs, session tags, and category tags are intentionally hidden. The board polls `.pi/todos` every 700ms, so tool and board changes stay synchronized.

To open the plugin pane manually from a Pi pane:

```bash
herdr plugin pane open \
  --plugin pi-adam.todos \
  --entrypoint board \
  --placement split \
  --direction right \
  --env "PI_ADAM_TODO_CWD=$PWD" \
  --env "PI_ADAM_TODO_SESSION_ID=$PI_SESSION_ID" \
  --env "PI_ADAM_TODO_SCOPE=session" \
  --no-focus
```

Do not pass `--cwd`: Herdr normally runs the command from the plugin root, where `board.js` lives.

## Structure

`index.ts` composes small, independent feature modules:

- `features/env.ts` — dotenv loading and `/env`
- `features/footer.ts` — custom session footer
- `features/codex-usage.ts` — read-only Codex usage and banked-reset API integration
- `features/herdr-todos.ts` — Pi session tagging, board lifecycle, scope, visibility, and `/herdr-todos`
- `features/mru.ts` — slash-command recency and editor integration
- `herdr-plugin/board.js` — interactive terminal board
- `herdr-plugin/todo-store.js` — shared parsing, filtering, transitions, and clearing
- `herdr-plugin/herdr-plugin.toml` — Herdr plugin manifest

Reload pi with `/reload` after changes.
