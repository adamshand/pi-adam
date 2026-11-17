# Herdr release review baseline

Check this file before reviewing another Herdr upgrade. The desktop app/core and
old Herdr TUI are different products; `~/.config/herdr/release-notes.json` is the
**TUI's** cached notes, not the desktop app's What's New.

## Reviewed 2026-11-15

| Product | Releases reviewed (inclusive) | Next review starts after |
| --- | --- | --- |
| Desktop `herdr-app` | **0.1.12–0.1.16** | **0.1.16** |
| `herdr-core` / `hc` | **0.1.17–0.1.21** | **0.1.21** |

These are review checkpoints, not claims that every upstream feature has been
adopted. Unless investigating an older regression, future agents can start with
releases newer than these checkpoints. Advance the table only after reviewing
notes against this repo, and record decisions below. Do not treat an Unreleased
section as shipped.

Sources:
- [Desktop app changelog](https://github.com/herdrdev/herdr-app/blob/master/CHANGELOG.md)
- [Core changelog](https://github.com/herdrdev/herdr-core/blob/master/CHANGELOG.md)
- Installed `~/.config/herdr-app/AGENTS.md` and `herdr.d.ts` for exact API contracts.

The old TUI's **v0.9.2–v0.9.5** notes were also inspected for context, but this
implementation pass targets the desktop integration. Do not use the TUI version
as the app/core review checkpoint. Installed binaries at review time: app 0.1.16,
core 0.1.21, TUI 0.9.5.

### Adopted in repository source

- **App 0.1.16 `checking()`:** all five custom mods initialize enough state to
  render, but checks skip background timers/tasks, subprocesses, watches, footer
  host/focus publication, and persistent state writes. Checking must not change a
  live Pi session's footer or tracking coverage.
- **App 0.1.16 cancellable folder watches:** Agents releases private/common Git
  watches when their final local agent leaves; shared worktree metadata stays
  watched while needed. Todos releases old session folders on focus/view changes,
  when hidden/inactive, and on close. Generation/identity checks keep cancelled
  tasks or late discovery from overwriting new watches. Existing polling remains
  the fallback; no additional timer was introduced.
- **App 0.1.15/0.1.16 custom chrome fixes:** Tabs reveals the active tab on
  selection, reorder, and size changes. Wheel notches switch once; smooth gestures
  accumulate/rate-limit instead of skipping a tab for each event. Tabs and Agents
  tolerate malformed saved state, preserve leading brackets in agent titles,
  ignore folder titles, and respect manually named tabs when deriving live labels.
  These are personal clones, so updating Herdr alone does not update them.
- **App 0.1.14 `exec` timeouts:** Git/Notes helpers use bounded 5–10 second
  timeouts. The existing focus sender already uses 6 seconds. The Work reader
  retains its default 30-second outer budget for its multiple bounded requests;
  no long-running agent timeout was added.

### Deliberately retained or not adopted

- **Keep `features/herdr-session-name.ts`.** Pi's terminal title is composite
  (`π - <session name> - <folder>`), and its OSC 7501 report only includes the
  session name in working/done states, not idle. Upstream's automatic-title
  fallback is not an exact replacement for our explicit `/name` contract,
  including idle startup/resume and clearing a name. The explicit bridge still
  treats a Pi `/name` as a request to rename its own tab; ordinary automatic
  labels in our chrome preserve manual names.
- **Keep Pi recovery.** Core's optional `restore_screen` shows the old screen
  above a fresh shell after reboot; it does not resume the saved Pi conversation.
  Process isolation fixes reduce app-quit losses but do not replace recovery.
  Terminals created before core 0.1.20 need reopening once to inherit the macOS
  isolation fixes. Do not restart the user's terminals as part of reviewing notes.
- Dock badges, background helper tabs, custom toasts and terminal copy/jump controls
  are optional new UI, not required fixes. No layout/settings changes here.
- Core's document-filtered event subscriptions were **Unreleased**, not available
  in the reviewed 0.1.21 release.

### Validation and deployment boundary

Regression tests exercise populated check-mode renders, malformed state, wheel
and active-tab behavior, shared worktree watches, cancelled-task replacement and
late discovery. Run `pnpm check` and `herdr-app check` on all five source mod
folders (`herdr/app/{agents,tabs,todos,notes,status}`). `check` writes generated
`gpui-kit.d.ts`/`jsconfig.json` beside the mod, so use a temporary source copy to
avoid adding generated files (or linting invalid upstream declarations) in this repo.

This pass changes **repository source only**. Installed mods and the live layout
were not changed: the working tree already contained in-progress time-tracking
work, including Status changes, and deploying it implicitly would be unsafe.
Source native checks are not a live visual check. Before deployment, back up each
installed personal mod, copy only reviewed source/assets using the integration
READMEs, then check installed mods, inspect `herdr-app status`, and capture/read a
screenshot. Never edit shipped Herdr mods or generated API files.
