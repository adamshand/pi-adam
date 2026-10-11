# Brief: store Pi Ideas in Work instead of `.pi/`

## Why

Ideas belong to a project and are useful across sessions and harnesses (Pi, Claude, Codex). They now live in **Work** (https://work.haume.nz), Adam's inbox for ideas, agent captures and feedback. Todos stay exactly as they are: local, session-scoped, in `.pi/work-items/`.

All 152 existing local Ideas have been imported into Work; each imported item's description ends with `Imported from Pi: \`<path>\``. Follow-up decision: retire the one-off migration script and all startup import/checking code, and remove this checkout's old Idea files. Work is now the sole Idea store.

## Work API (summary; the contract is `GET https://work.haume.nz/api/openapi.json`)

- Auth: `Authorization: Bearer <token>`. Read the token from the Keychain with `security find-generic-password -s work.haume.nz -w`, let `WORK_API_TOKEN` override it, and let `WORK_URL` override the base URL. Cache the token in memory. Never log it or write it anywhere.
- `GET /api/v1/work?state=inbox,open&project=<slug>`: active items. Each has `id` (`work_<24 hex>`), `title`, `description` (Markdown), `state` (inbox|open|done|dropped), `priority`, `goal`, `source`, `revision` and `created_at`.
- `POST /api/v1/work {title, description, project, source}`: creates an item, which always starts in `inbox`. Use `source: "idea"` for Adam's `/idea` and `source: "agent"` when the agent captures one.
- `PATCH /api/v1/work/{id} {revision, state?, title?, description?, comment?, …}`: every PATCH needs the current `revision`. On `409`, re-fetch and reapply. There is no delete; use `state: "dropped"`.
- `GET /api/v1/projects`: project slugs.

## What to change

1. **Project for a cwd.** Resolve the git repo root, then use the first of these that applies:
   - an optional `.pi/work.json` file with `{"project": "<slug>"}`;
   - the repo directory name with `.git` stripped, if it matches a Work project slug;
   - no project.
   `~/src/haume/made.git` should map to `haume-made`, so add a `.pi/work.json` there or a small alias table. The import script's `PROJECTS` table has the full mapping.
2. **`idea` tool and `/idea` command.** Back `list`, `create`, `update` and `delete` with the API, scoped to the cwd's project:
   - `list`: show inbox and open items for this project, from every source, so the agent sees feedback too.
   - `create`: put `intent` and the checklist into `description` as Markdown (`- [ ] item`).
   - `delete`: set the item to `dropped`, with a comment.
   - Display IDs: keep a short form, e.g. `IDEA-<last 6 hex>`, and resolve it against the listed items.
3. **Promote / defer.**
   - **Promote:** PATCH the Work item to `open` with the comment `Promoted into Pi session <id>`, and create the local todo with the Work id stored in it.
   - **Todo completed:** when a todo carrying a Work id is completed, offer to PATCH that item to `done`.
   - **Defer:** with a Work id, PATCH the item back to `inbox`. Without one, POST a new idea.
4. **Herdr board, ideas view.** Read ideas from the same API path, not from `.pi/work-items`.
5. **Offline / failure.** 5 s timeouts. Never block session start on Work.
   - **Failed creates:** append them to `~/.local/state/pi-adam/work-outbox.jsonl` and flush on the next successful call.
   - **Failed lists:** fall back to the last cached list, clearly marked as stale.
6. **Prompt guidance.** Update the tool descriptions and `promptGuidelines` in `features/todos.ts`. The current text says "Ideas are project scoped", "promote/defer" and "reconcile Todos and Ideas"; make it say that Ideas live in Work. The `work-triage` skill (`skills/work-triage/`) covers bulk triage, so point to it rather than repeating it.
7. **Local idea storage.** Do not create or list local `kind: "idea"` files. The one-off migration is complete; no automatic import or legacy Idea warning remains.

## Done when

- `/idea …` in a repo creates an inbox item in Work under that repo's project, shown with its age, and nothing is written to `.pi/`.
- `idea list` matches the project's view on work.haume.nz.
- Promoting, completing and deferring an idea all show up in that item's activity on Work.
- Tests run against a fake HTTP server, not the live site, and cover 409 retry and the offline outbox.
