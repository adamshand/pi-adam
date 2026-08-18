---
name: agent-browser
description: Use agent-browser for headless browser interaction, local application testing, screenshots, console and network diagnostics, forms, authentication, and exploratory UI work.
compatibility: Requires the agent-browser executable.
---

# Agent Browser

- Pi has already configured `AGENT_BROWSER_SESSION`, do not export or replace it (use explicit sessions only for deliberate multi-user testing, and close them yourself).
- Sessions are automatically closed.
- agent-browser is installed and in your path (Chrome has been installed as well)
- Use `--headed` when you want to show something to Adam

## Usage

Use the below examples to get started.  If they aren't sufficient:

1. Run `agent-browser <command> --help` for specific instructions
2. Run `agent-browser skills get core` for more comprehensive documentation & examples

## Examples (version `0.34.0`)

  agent-browser open example.com
  agent-browser snapshot -i              # Interactive elements only
  agent-browser click @e2                # Click by ref from snapshot
  agent-browser fill @e3 "test@example.com"
  agent-browser find role button click --name Submit
  agent-browser get text @e1
  agent-browser screenshot --full
  agent-browser screenshot --annotate    # Labeled screenshot for vision models
  agent-browser wait 2000               # Wait for slow pages to settle
  agent-browser --cdp 9222 snapshot      # Connect via CDP port
  agent-browser --cdp 9222 --pin-tab open example.com  # Pin session to its own tab
  agent-browser --auto-connect snapshot  # Auto-discover running Chrome
  agent-browser stream enable            # Start runtime streaming on an auto-selected port
  agent-browser stream status            # Inspect runtime streaming state
  agent-browser --color-scheme dark open example.com  # Dark mode
  agent-browser --profile Default open gmail.com        # Reuse Chrome login state
  agent-browser --profile ~/.myapp open example.com    # Persistent custom profile
  agent-browser profiles                               # List available Chrome profiles
  SESSION="$(agent-browser session id --scope worktree --prefix myapp)"
  agent-browser --session "$SESSION" --restore open example.com  # Auto-save/restore state
  agent-browser session info --json                    # Inspect daemon and restore status
  agent-browser chat "open google.com and search for cats"  # AI chat (single-shot)
  agent-browser chat                                        # AI chat (interactive REPL)
  agent-browser -q chat "summarize this page"               # Quiet mode (text only)

Command Chaining:
  Chain commands with && in a single shell call (browser persists via daemon):

  agent-browser open example.com && agent-browser snapshot -i
  agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "pass" && agent-browser click @e3
  agent-browser open example.com && agent-browser screenshot

iOS Simulator (requires Xcode and Appium):
  agent-browser -p ios open example.com                    # Use default iPhone
  agent-browser -p ios --device "iPhone 15 Pro" open url   # Specific device
  agent-browser -p ios device list                         # List simulators
  agent-browser -p ios swipe up                            # Swipe gesture
  agent-browser -p ios tap @e1                             # Touch element
