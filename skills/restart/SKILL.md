---
name: restart
description: Restart the cookiedclaw Claude Code session via its systemd user unit. Use after installing a new skill / plugin / MCP server (anything that's only discovered at startup), or when the agent itself asks to be reborn. Requires `/cookiedclaw:enable-daemon` to have been run first.
allowed-tools: Bash(systemctl --user restart cookiedclaw) Bash(systemctl --user status cookiedclaw*) Bash(systemctl --user is-active cookiedclaw)
---

# Restart cookiedclaw

Restarts the cookiedclaw Claude Code session. The current process (and you, the agent inside it) gets terminated by systemd, then a fresh CC starts with the same plugin, channel, and identity files.

## Pre-flight

Confirm the daemon mode is set up:

```bash
systemctl --user is-active cookiedclaw
```

If this prints anything other than `active`, the daemon isn't running and there's nothing to restart. Tell the user to run `/cookiedclaw:enable-daemon` first.

## Warn the user, then restart

Send a Telegram message warning the user, because the next thing that happens is your own death:

> 🔄 Restarting cookiedclaw — I'll be back in a few seconds. Conversation context will reset, but identity files (IDENTITY/USER/SOUL) are reread on boot.

Then issue the restart:

```bash
systemctl --user restart cookiedclaw
```

This call may or may not return before systemd sends SIGTERM to your own process. Either way, do not try to send another Telegram message after issuing the restart — the channel server is going down with you.

## After restart

The fresh CC session will:
1. Reload all skills, plugins, and MCP servers (this is the whole point)
2. Restart the channel server, which republishes the bot menu
3. Reload `IDENTITY.md` / `USER.md` / `SOUL.md` / `HEARTBEAT.md` from the workspace
4. Drop the conversation history — fresh start

The user will not see a "back online" message automatically. If continuity matters, the user pings the bot first; the new session picks up the DM as a fresh `<channel source="telegram">` event.

## Notes

- This skill is for the case where the agent itself decides to restart, or the user explicitly asks. For non-systemd setups (the default ad-hoc launch), this skill exits with an error message instead — restart is a manual `Ctrl+C → up-arrow → enter` job.
- If the restart fails (`systemctl restart` returns non-zero), surface the failure with `systemctl --user status cookiedclaw --no-pager` so the user sees the journalctl tail.
