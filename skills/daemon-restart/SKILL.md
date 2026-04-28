---
name: daemon-restart
description: Restart the cookiedclaw Claude Code session via the gateway's `restart_runtime` MCP tool. Use after installing a new skill / plugin / MCP server (anything that's only discovered at startup), or when the agent itself asks to be reborn. Requires `/cookiedclaw:setup` to have been run first.
allowed-tools: Bash(systemctl --user is-active cookiedclaw-gateway) Bash(systemctl --user status cookiedclaw-gateway --no-pager) mcp__cookiedclaw__restart_runtime
---

# Restart cookiedclaw

Restarts the cookiedclaw Claude Code session. The current process (and you, the agent inside it) gets terminated by the gateway's supervisor, then a fresh CC starts with the same plugin, channel, and identity files.

## Pre-flight

Confirm the daemon mode is set up:

```bash
systemctl --user is-active cookiedclaw-gateway
```

If this prints anything other than `active`, the gateway isn't running and there's nothing to restart. Tell the user to run `/cookiedclaw:setup` first.

## Warn the user, then restart

Send a Telegram message warning the user, because the next thing that happens is your own death:

> 🔄 Restarting cookiedclaw — I'll be back in a few seconds. Conversation continues via `--continue`; identity files (IDENTITY/USER/SOUL) reread on boot.

Then call the gateway's `restart_runtime` MCP tool:

```
mcp__cookiedclaw__restart_runtime { "reason": "skill/plugin reload via /cookiedclaw:daemon-restart" }
```

The tool returns immediately. The gateway delays the actual SIGTERM by ~2 seconds so this skill can return and the warning message above can flush to Telegram before the channel server goes down with the rest of CC. End your turn after issuing the tool call — don't try to send another message; everything past this point happens in the next session.

## After restart

The fresh CC process will:
1. Reload all skills, plugins, and MCP servers (this is the whole point)
2. Reconnect to the gateway over MCP, which republishes the bot menu
3. Reload `IDENTITY.md` / `USER.md` / `SOUL.md` from the workspace
4. Resume the previous conversation via `claude --continue` (baked into the launcher) — recent context survives the restart

The user will not see a "back online" message automatically. If continuity matters, the user pings the bot; the new session picks up the DM and continues the prior thread.

## Notes

- This skill restarts only the CC child, not the gateway itself. The Telegram bot, MCP-over-HTTP server, and progress endpoint stay up across the restart — you'll just briefly have an empty `liveServers` set until the new CC reconnects.
- If the gateway itself is what you need to restart (e.g. to pick up a new gateway binary), that's a `systemctl --user restart cookiedclaw-gateway` job, not this skill.
- If the restart fails (no `liveServers` after ~30s), surface `systemctl --user status cookiedclaw-gateway --no-pager` so the user sees the journal tail.
