# pi-adam

Personal pi quality-of-life extension.

## Features

- Slash-command autocomplete is sorted by most recently used commands.
- Compact custom footer keeps model, thinking level, and active Codex Fast mode on the left, with cost, context usage, and Codex limits right-aligned.
- `/fast` toggles Fast mode for supported GPT-5.4–5.6 Codex models using ChatGPT OAuth; `alt+shift+tab` does the same.
- `codex_image` generates and saves images through Codex's native `gpt-image-2` hosted tool.
- Loads dotenv-style variables from `~/.pi/env`, then trusted project `.pi/env` files. Existing shell variables take precedence.
- `/env` lists variables declared by those files with values redacted.
- `/codex-usage` shows Codex usage, reset times, and available banked resets; `/codex-usage-refresh` refreshes it immediately.
- Slash-command usage is stored in `state.json` next to this extension.
- `/pi-adam-mru` shows the recent list; `/pi-adam-mru reset` clears it.
- Inside Herdr, Pi `/name` values automatically rename the tab and appear beneath the workspace name in the agents panel.
- The work ledger keeps current-session Todos visible in a Herdr pane while retaining project-wide Ideas for later.

## Herdr session names

When Pi runs inside Herdr, `/name bugs` renames the current tab and reports `bugs` as the visible agent label. This package expects the following Herdr sidebar layout in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace"], ["agent"]]
```

Reload Herdr configuration with `herdr server reload-config` after changing it. Clearing the Pi session name restores the tab's numeric label and the normal `pi` agent label.

## Todos and Ideas

The ledger deliberately has only two kinds of work:

- **Todo** — an active commitment owned by the current Pi session.
- **Idea** — a project-wide possibility, follow-up, or future commitment retained for later.

Promoting an Idea turns it into a Todo in the current session. Deferring an unfinished Todo turns it back into an Idea. Ideas can also be dismissed; completed Todos can be cleared. There are no project-scoped Todos or scope tags in the user-facing model.

Capture work directly from Pi:

```text
/todo Implement this in the current session
/idea Review this approach later
/todos
```

Omitting a title from `/todo` or `/idea` opens an input prompt. The agent-facing `todo` and `idea` tools use the same model. Todos live under `.pi/todos`; Ideas live under `.pi/ideas`.

The extension automatically migrates unfinished legacy project-tagged or unscoped Todos into Ideas. Existing session-tagged Todos remain with their sessions.

## Herdr board

Link the local Herdr plugin once during development:

```bash
herdr plugin link "$PWD/herdr/todos"
```

The stable plugin ID remains `pi-adam.todos`. The board opens automatically at roughly one-third of the tab width while the current session has unfinished Todos. Ideas never open it automatically. The board has two views:

```text
TODOS | IDEAS
```

Use `Tab`, `i`, or the clickable labels to switch views. The Pi command controls the pane:

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

In **TODOS**, select with `↑`/`↓` or `j`/`k` and press Space to cycle:

```text
○ outstanding → ◐ in progress → ✓ done → ○ outstanding
```

Press `f` to defer the selected unfinished Todo to Ideas. In **IDEAS**, press `p` to promote the selected Idea into the current session or `x` to dismiss it with confirmation. Press `d` to expand context and checklist details, `c` to clear completed Todos, and `q` to close the pane.

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

## Structure

`index.ts` composes small feature modules:

- `features/env.ts` — dotenv loading and `/env`
- `features/footer.ts` — custom session footer
- `features/codex-fast.ts` — guarded, session-persisted Codex Fast mode
- `features/codex-image.ts` — Codex-hosted image generation and file saving
- `features/codex-image-utils.ts` — image payload and SSE parsing helpers
- `features/codex-usage.ts` — read-only Codex usage and banked-reset API integration
- `features/herdr-session-name.ts` — Pi `/name` synchronization with Herdr tabs and agent titles
- `features/todos.ts` — canonical Todo/Idea tools, commands, guidance, and legacy migration
- `features/herdr-todos.ts` — Herdr board lifecycle, visibility, metadata, and `/todos`
- `features/mru.ts` — slash-command recency and editor integration
- `herdr/todos/board.js` — interactive Herdr board
- `herdr/todos/todo-store.js` — canonical Todo persistence and transitions
- `herdr/todos/idea-store.js` — canonical Idea persistence, promotion, and deferral
- `herdr/todos/view-state.js` — session-local board view state
- `herdr/todos/herdr-plugin.toml` — Herdr plugin manifest

Reload Pi with `/reload` after changes. Because the Herdr plugin path moved, relink it once with the command above.
