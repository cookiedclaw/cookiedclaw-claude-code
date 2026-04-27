---
name: daemon-status
description: Show the cookiedclaw systemd daemon's current state — running/stopped, last restart, workspace path, recent journalctl tail. Use when the user asks "is cookiedclaw running?", "what's the daemon doing?", or wants a quick health check before debugging.
allowed-tools: Bash(systemctl --user is-active cookiedclaw) Bash(systemctl --user is-enabled cookiedclaw) Bash(systemctl --user status cookiedclaw --no-pager) Bash(systemctl --user show cookiedclaw --property=*) Bash(journalctl --user -u cookiedclaw *) Read
---

# Daemon status

Quick health check on the cookiedclaw systemd unit. Use this before assuming the daemon is healthy — it gives a one-glance summary so you can decide whether to restart, check logs, or just answer "yep, all good".

## What to gather

Run these in parallel where possible:

```bash
# Is the unit running right now?
systemctl --user is-active cookiedclaw

# Is it enabled to start at boot?
systemctl --user is-enabled cookiedclaw

# When did it last (re)start, what's the pid, etc — combined call
systemctl --user show cookiedclaw --property=ActiveEnterTimestamp,MainPID,Restarts,SubState,Environment

# Last 15 log lines for context
journalctl --user -u cookiedclaw --no-pager -n 15
```

The `Environment=WORKSPACE=…` line in `systemctl show` output is set by the unit (see `enable-daemon` Step 5). Parse it out for display.

## How to present

Format the answer as a compact summary, not a wall of raw output. Example:

```
🟢 cookiedclaw daemon

  state:       active (running) · sub-state: running
  enabled:     enabled
  workspace:   /home/p5ina/cookiedclaw
  pid:         12345
  last start:  2026-04-27 04:12:33 (32m ago)
  restarts:    3 (since boot)

last 15 log lines:
  …
```

If the unit doesn't exist (`is-active` returns "inactive" + `is-enabled` returns "disabled"), tell the user the daemon isn't set up — point at `/cookiedclaw:enable-daemon`.

If it's `failed` or `activating (auto-restart)`, surface the journal tail prominently — that's where the cause shows up. Don't try to diagnose; show the data and let the user decide.

## When to call this

- User asks any "is it running?" / "are you alive?" / "что с демоном?" question
- Before `/cookiedclaw:daemon-restart` if you're unsure restart is even needed
- After `/cookiedclaw:install-skill` from a fresh session to confirm the new skill landed (next session does this, not the dying one)

Do not auto-call this every time — only when the user asks or the agent has reason to suspect a problem.
