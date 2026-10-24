---
name: work-triage
description: Read, capture and triage Adam's work items, ideas and feedback reports in Work (mahi.haume.nz) through its API. Use when asked to triage the inbox, check feedback or bug reports, find what to work on next, capture an idea, or update a work item or goal.
---

# Work triage

Work (https://mahi.haume.nz) is Adam's inbox for ideas, agent captures and Feedback Reports from tools like `hm`. Items move `inbox → open → done`, or to `dropped`. They can carry a `priority` (must/should/later), a `goal`, and a `blocked_reason`.

## Access

The API token is in the macOS Keychain. Never print it, echo it or put it in a file:

```bash
work() { curl -sS -H "Authorization: Bearer $(security find-generic-password -s mahi.haume.nz -w)" -H 'Content-Type: application/json' "https://mahi.haume.nz${@:1:1}" "${@:2}"; }
work '/api/v1/work?state=inbox'                    # also: state=inbox,open  project=…  goal=…  blocked=true
work /api/v1/reports/FB-…                          # summary, reporter, context, artifacts, conversation
work /api/v1/reports/FB-…/bundle -o /tmp/FB-….zip  # the diagnostic bundle (each download is logged)
work /api/v1/work/work_… -X PATCH -d '{"revision":N,"state":"done","comment":"Triage (agent): …"}'
```

`GET /api` lists every resource and `/api/openapi.json` is the full contract. For more than a couple of changes, write a small script, Python or similar, that reads the token the same way.

## Triage loop

1. **Fetch everything first** (`state=inbox,open` plus each item's report) and read it side by side. Duplicates only show up when you compare items.
2. **Group duplicates.** Close the extras as `done` or `dropped`, each with a comment naming the item kept, e.g. "Duplicate of FB-…".
3. **Verify before closing.** An old report is not a fixed report. Check the current state and quote what you found in the comment:
   - the installed tool's `--version` and `--help`
   - the source repo's `git log --grep` for a fix commit
   - `curl` against the live URL
   - replies already on the report ("Resolved in production…")
   If it's probably fixed but you couldn't prove it, say "likely fixed by … reopen if it recurs".
4. **Keep what's still real** as `open`, with a priority and, when it fits, a goal (`GET /api/v1/goals`). In the comment, list exactly what is unverified, so the next agent starts from there.
5. **Drop test and smoke-test reports**, and reports superseded by newer ones.
   - Most ideas are speculative ("Consider…", "Revisit… when needed"). Accept them as `open` + `later` rather than leaving them in the inbox. Reserve `must` for what blocks a goal.
   - Ideas imported from Pi end with `Imported from Pi: <file> (session <id>)`. When one is too vague to judge, that session has the context.
6. **Report back to Adam:** what you closed and why (grouped), and what's left open, ranked.

## Rules

- Every `PATCH` needs the current `revision`. On a `409`, re-fetch and reapply your change; never retry blindly.
- Changing a feedback item's state changes what its reporter sees: inbox = new, open = investigating, done = resolved, dropped = closed.
- `comment` on a work item is internal. `POST /api/v1/reports/{ref}/comments` with `"visibility":"reporter"` messages a real person: ask Adam first. `"internal"` is fine.
- Don't change Adam's own ideas (`source: idea`) beyond adding a comment, unless he asks.
- Capture new ideas with `POST /api/v1/work {"title","description","project","source":"agent"}`. They land in the inbox for Adam.
