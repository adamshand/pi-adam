# Personal agents sidebar

Source snapshot of the existing `adam-agents` personal mod; no shipped mod changes.

Git rows retain their existing five-second scheduling check and one-minute Git
fallback while the window is active. Local repositories also use Herdr's native
`watchFolder` on their actual Git directory and common directory (both are needed
for linked worktrees). No working-tree watcher or new repeating timer is added.
Watchers are shared per metadata directory, including multiple agents in one repo.
Pending watch handles are cancelled when the last local agent using their
metadata directory leaves, including when panes change working directory. Shared
common-directory watches remain while another linked worktree needs them. Close
cancels all pending handles; generation guards discard late discovery and cancelled
loops without touching replacement watches. Herdr also cancels tasks on removal.

Index, HEAD, refs, packed-refs, config and shallow-state events invalidate the
corresponding cached rows. Bursts coalesce for 400ms; object/reflog/lock-file noise
is ignored. Git queries disable optional locks and fsmonitor to avoid self-induced
watcher feedback. Revisions preserve changes arriving during a Git query; if busy
or inactive, the existing scheduling check picks them up later. Remote repositories
keep the existing slow refresh; failed local watchers retry on a later refresh.
Ordinary unstaged edits outside Git metadata still use the fallback/agent events.
The separate Pi-driven footer now has its own local metadata watcher in
`features/footer-git-watch.ts`, sharing this module's event filter. It requires
Pi `/reload`; the sidebar watcher itself reloads live.

Deploy after backing up the installed personal mod:

```sh
cp herdr/app/agents/{main.js,git-events.js,mod.json} ~/.config/herdr-app/mods/adam-agents/
herdr-app check ~/.config/herdr-app/mods/adam-agents
herdr-app status
herdr-app shot /tmp/herdr-agents-git.png
```

Requires herdr-app 0.1.16+ for `checking()` and cancellable watch handles. Native
checks initialize/render the sidebar without Git helpers, timers, watches or
persistent writes. `main.test.js` covers watch lifetime/races and damaged saved
state; the shared check-mode regression is in `../status/checking.test.js`.
See [`../../RELEASE-REVIEWS.md`](../../RELEASE-REVIEWS.md) for the review baseline.

`git-events.test.js` covers metadata filtering, linked-worktree paths, shared event
bursts, no idle scheduling, and invalidations arriving during a query. Native checks
verify module loading/rendering. No commits or staging operations in user projects
are needed to test/install this change.
