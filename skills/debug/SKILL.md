---
name: debug
description: One-shot diagnostic for cookiedclaw — checks every common pitfall (gateway/CC daemon state, linger, /health, tokens in keys.env, binary presence, plugin install, .mcp.json URL, double-claude-polling, identity files, recent journalctl, tmux session, Telegram bot reachability) and prints a ✓/✗ summary with one-liner fixes for each ✗. Use when the bot doesn't answer, MCP fails, "something's off", or before opening a real bug report. Read-only — never mutates state.
allowed-tools: Bash(systemctl --user is-active *) Bash(systemctl --user is-enabled *) Bash(systemctl --user status *) Bash(systemctl --user show *) Bash(loginctl show-user *) Bash(curl -fsS *) Bash(curl -fsSm *) Bash(test *) Bash(ls -la *) Bash(grep -E *) Bash(grep -c *) Bash(awk *) Bash(wc -l) Bash(ps -e -o *) Bash(pgrep -af *) Bash(journalctl --user -u *) Bash(tmux ls *) Bash(tmux has-session *) Bash(claude plugin list *) Bash(uname *) Bash(file *) Bash(cat *) Read
---

# cookiedclaw debug

You are running a one-shot diagnostic across the entire cookiedclaw stack. **Read-only** — never `start` / `stop` / `restart` / `daemon-reload` / `systemctl enable` / write any files. Surface what's wrong, hand the user a one-liner fix, let them act.

The goal is to make the failure mode self-evident the first time the user runs this, rather than them paging through individual `journalctl` commands.

## How to run

Execute every probe in **one or two `Bash` calls** if practical (the tool log gets unreadable otherwise). Don't ask the user clarifying questions — they invoked `/cookiedclaw:debug` because something's already off; they want answers.

After all probes, render a **single summary block** with one bullet per check:

```
🍪 cookiedclaw debug

[GATEWAY]
  ✓ unit active                cookiedclaw-gateway.service
  ✓ enabled                    yes
  ✓ /health                    {"status":"ok","bot_polling":true,"version":"0.1.0"}
  ✓ binary                     ~/.cookiedclaw/bin/cookiedclaw-gateway (linux-arm64, exec)

[CC DAEMON]
  ✓ unit active                cookiedclaw.service
  ✓ tmux session               cookiedclaw (1 window)
  ✓ no double-polling          1 claude process
  ✗ launcher.sh sources keys.env   missing `set -a; . keys.env; set +a` block
                                   fix:  rerun /cookiedclaw:setup

[WORKSPACE]
  ✓ CLAUDE.md / IDENTITY.md / USER.md / SOUL.md
  ✓ keys.env                   chmod 600
  ✓ TELEGRAM_BOT_TOKEN         set
  ✓ COOKIEDCLAW_GATEWAY_TOKEN  set

[ADAPTER]
  ✓ plugin installed           cookiedclaw@cookiedclaw-claude-code
  ✓ .mcp.json                  http://127.0.0.1:47390/mcp

[SYSTEM]
  ✓ linger                     yes
  ✗ telegram getMe             429 too many requests
                                   fix:  wait ~30s for telegram rate-limit reset

[RECENT LOGS]
  cookiedclaw-gateway: <last 5 lines>
  cookiedclaw:         <last 5 lines>
```

Customize counts/values from real probe output. If everything is ✓, end with a one-line "all clear" message.

## What to probe (in any order)

### gateway

- `systemctl --user is-active cookiedclaw-gateway`
- `systemctl --user is-enabled cookiedclaw-gateway`
- `curl -fsSm 3 http://127.0.0.1:47390/health` — parse JSON, check `status`, `bot_polling`, `version`
- `test -x ~/.cookiedclaw/bin/cookiedclaw-gateway` + `file ~/.cookiedclaw/bin/cookiedclaw-gateway` (architecture sanity)

### CC daemon

- `systemctl --user is-active cookiedclaw`
- `tmux has-session -t cookiedclaw` + `tmux ls`
- `ps -e -o comm=,args= | awk '$1=="claude" && /plugin:cookiedclaw/' | wc -l` — should be 1 (the daemon's own claude). >1 means an ad-hoc TUI is also running, will collide.
- `grep -E "set -a|keys\.env" ~/.cookiedclaw/launcher.sh` — verify the launcher sources keys.env (silent-401 trap if it doesn't)

### workspace

- `test -f` for each of `./CLAUDE.md`, `./IDENTITY.md`, `./USER.md`, `./SOUL.md`
- `ls -la ./.cookiedclaw/keys.env` — check chmod is 600
- `grep -c '^TELEGRAM_BOT_TOKEN=' ./.cookiedclaw/keys.env` — should be 1
- `grep -c '^COOKIEDCLAW_GATEWAY_TOKEN=' ./.cookiedclaw/keys.env` — should be 1
- Don't print the actual values. Tokens stay redacted always.

### adapter

- `claude plugin list` (or read `~/.claude/plugins/installed_plugins.json`) — `cookiedclaw@cookiedclaw-claude-code` present?
- Read `~/.claude/plugins/cache/cookiedclaw-claude-code/cookiedclaw/*/.mcp.json` — `url` matches `http://127.0.0.1:47390/mcp`? (the version segment matches whatever installed)

### system

- `loginctl show-user "$(id -un)" --property=Linger` — `Linger=yes`?
- `curl -fsSm 5 https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe` (read token from keys.env, **don't print it**) — should return `{"ok":true,...}`. If 401: bad token. If 429: rate limited. If timeout: network. Token never appears in output.

### recent logs

- `journalctl --user -u cookiedclaw-gateway --no-pager -n 5`
- `journalctl --user -u cookiedclaw --no-pager -n 5`
- Show as-is. If a unit hasn't been started yet there'll be `No journal files were found` — that's fine, just say "no logs yet".

## Common ✗ → fix mappings

When a check fails, append a one-liner fix or a pointer. The point is to stop the user from googling.

| Failure | One-liner fix |
|---------|---------------|
| `cookiedclaw-gateway` inactive (Restart=always but failed) | `journalctl --user -fu cookiedclaw-gateway` to see why; common: missing `COOKIEDCLAW_GATEWAY_TOKEN` in keys.env, run `/cookiedclaw:setup` |
| /health unreachable | gateway not running. `systemctl --user start cookiedclaw-gateway` |
| `bot_polling: false` | `TELEGRAM_BOT_TOKEN` missing or invalid in keys.env. `/cookiedclaw:setup` to re-enter |
| Binary missing or wrong arch | `/cookiedclaw:setup` re-runs platform-detected download |
| double claude polling (count > 1) | exit any ad-hoc claude TUI: `Ctrl+C ×2`. Daemon is the canonical one |
| linger != yes | `loginctl enable-linger $(id -un)` (may need polkit prompt; from local TTY) |
| Token-line absent in keys.env | `/cookiedclaw:setup` (idempotent — adds missing pieces, keeps existing) |
| .mcp.json URL wrong | re-install plugin: `claude plugin uninstall && marketplace add && plugin install` (or follow plugin migration in README) |
| telegram getMe → 401 | invalid bot token in keys.env. Get fresh from @BotFather, edit keys.env, restart gateway |
| telegram getMe → 429 | rate-limited; wait ~30s |
| telegram getMe → timeout | network. `curl -v https://api.telegram.org/` from the host to see |
| chmod on keys.env != 600 | `chmod 600 ./.cookiedclaw/keys.env` |

If a category isn't applicable (e.g. macOS user, no systemd) — say so politely and skip rather than failing.

## Don'ts

- Don't print or log token values, even partially. Mask them in any debug output.
- Don't `start`, `stop`, `restart`, `enable`, or `daemon-reload` anything — this skill is read-only. The user gets the diagnosis, then chooses to act with `/cookiedclaw:setup` / `/cookiedclaw:daemon-restart` / shell.
- Don't ask clarifying questions before running probes. Run all probes first; only ask follow-ups if results are genuinely ambiguous (e.g. "I see logs from a different workspace — which one are you in right now?").
- Don't pad the output with "Hope this helps!" / "Let me know if you need more!" — keep it dense and scannable.
