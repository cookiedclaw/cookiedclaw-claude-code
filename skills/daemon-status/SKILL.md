---
name: daemon-status
description: Show the cookiedclaw daemon's current state — running/stopped, last restart, workspace path, supervised CC child status (pid, uptime, restart count, live MCP sessions), recent journalctl tail. Use when the user asks "is cookiedclaw running?", "what's the daemon doing?", or wants a quick health check before debugging.
allowed-tools: Bash(systemctl --user is-active cookiedclaw-gateway) Bash(systemctl --user is-enabled cookiedclaw-gateway) Bash(systemctl --user status cookiedclaw-gateway --no-pager) Bash(systemctl --user show cookiedclaw-gateway --property=*) Bash(journalctl --user -u cookiedclaw-gateway --no-pager -n *) Bash(curl -fsS http://127.0.0.1:*/health) Read
---

# Daemon status

Quick health check on the cookiedclaw daemon. Use this before assuming things are healthy — it gives a one-glance summary so you can decide whether to restart, check logs, or just answer "yep, all good".

## What to gather

There's only one systemd unit now (`cookiedclaw-gateway.service`) — the gateway supervises its own CC child internally. Run these in parallel where possible:

```bash
# Is the unit running right now?
systemctl --user is-active cookiedclaw-gateway

# Is it enabled to start at boot?
systemctl --user is-enabled cookiedclaw-gateway

# When did it last (re)start, what's the pid, etc — combined call.
systemctl --user show cookiedclaw-gateway --property=ActiveEnterTimestamp,MainPID,Restarts,SubState,Environment

# Supervised child + live MCP session count, served by the gateway.
# Port comes from the unit's GATEWAY_PORT env (default 47390).
curl -fsS http://127.0.0.1:47390/health

# Last 25 log lines for context.
journalctl --user -u cookiedclaw-gateway --no-pager -n 25
```

The `Environment=WORKSPACE=…` line in `systemctl show` output is set by the unit (see `setup` Step 4h). Parse it out for display.

The `/health` JSON looks like:

```json
{
  "status": "ok",
  "bot_polling": true,
  "version": "0.1.2",
  "runtime": {
    "enabled": true,
    "state": "running",
    "pid": 12345,
    "uptime_s": 1834,
    "restarts": 2,
    "live_sessions": 1
  }
}
```

`runtime.state` values: `off` (supervisor disabled), `starting` (child spawned, no MCP session yet), `running` (child up, ≥1 MCP session), `backoff` (child died, waiting before respawn), `stopping` (gateway shutting down).

## How to present

Format the answer as a compact summary, not a wall of raw output:

```
🟢 cookiedclaw daemon

  unit:        cookiedclaw-gateway · active (running)
  enabled:     enabled
  workspace:   /home/p5ina/cookiedclaw
  gateway pid: 12345
  last start:  2026-04-28 12:08:43 (32m ago)

  supervised CC:
    state:       running
    pid:         12678
    uptime:      30m 22s
    restarts:    2
    sessions:    1 live MCP session

last 15 log lines:
  …
```

If `runtime.state` is `backoff` or `live_sessions` is 0 with `state=running`, that's a hint the watchdog is about to fire — surface it.

If the unit doesn't exist (`is-active` returns "inactive" + `is-enabled` returns "disabled"), tell the user the daemon isn't set up — point at `/cookiedclaw:setup`.

If `/health` returns a connection refused, the gateway process isn't bound (or crashed mid-boot). Surface the journal tail.

If the unit is `failed` or `activating (auto-restart)`, surface the journal tail prominently — that's where the cause shows up. Don't try to diagnose; show the data and let the user decide.

## Legacy unit cleanup

Older installs had a second `cookiedclaw.service` unit that the gateway has since absorbed. If you see it active alongside `cookiedclaw-gateway`, mention it — the user should re-run `/cookiedclaw:setup` to clean it up (the wizard's Step 4c removes the legacy unit on re-run).

## When to call this

- User asks any "is it running?" / "are you alive?" / "что с демоном?" question
- Before `/cookiedclaw:daemon-restart` if you're unsure restart is even needed
- After `/cookiedclaw:install-skill` from a fresh session to confirm the new skill landed (next session does this, not the dying one)

Do not auto-call this every time — only when the user asks or the agent has reason to suspect a problem.
