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

## Structure

`index.ts` composes three small, independent feature modules:

- `features/env.ts` — dotenv loading and `/env`
- `features/footer.ts` — custom session footer
- `features/codex-usage.ts` — read-only Codex usage and banked-reset API integration
- `features/mru.ts` — slash-command recency and editor integration

Reload pi with `/reload` after changes.
