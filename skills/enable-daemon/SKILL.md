---
name: enable-daemon
description: One-time onboarding wizard that turns the current ad-hoc Claude Code launch into a systemd-managed daemon. After this, cookiedclaw survives logout, reboots, and crashes — and the agent can restart itself remotely from Telegram via /cookiedclaw:daemon-restart. Run this once per workspace, from inside the workspace directory.
disable-model-invocation: true
allowed-tools: Bash(uname *) Bash(which *) Bash(command -v *) Bash(loginctl enable-linger *) Bash(loginctl show-user *) Bash(systemctl --user daemon-reload) Bash(systemctl --user enable cookiedclaw) Bash(systemctl --user is-active cookiedclaw) Bash(systemctl --user is-enabled cookiedclaw) Bash(mkdir -p *) Bash(test *) Bash(pwd) Bash(id -un) Bash(getent passwd *) Bash(pgrep -af *) Bash(wc -l) Bash(chmod 700 *) Read Write Edit
---

# Going daemon

You are walking the user through converting their **current workspace** from a hand-launched `claude --dangerously-load-development-channels …` into a `systemd --user`-managed service.

The end state:
- `~/.config/systemd/user/cookiedclaw.service` exists and is enabled
- `loginctl enable-linger` is on for the user (service survives logout)
- A small launcher script lives at `~/.cookiedclaw/launcher.sh` (mode 0700, workspace path baked in via heredoc)
- `systemctl --user start cookiedclaw` brings it up; `daemon-restart` and `stop` work as expected

After this, the user never touches the terminal to restart CC again. Cookie can do it from Telegram.

## Step 0 — Greet, name the trade-offs

Send this so the user knows what's about to happen:

```
Going daemon mode. After this:

  ✓ cookiedclaw survives logout, reboots, crashes (auto-restart)
  ✓ Cookie can /cookiedclaw:daemon-restart itself from Telegram
  ✓ /cookiedclaw:install-skill works without you touching the terminal
  ✗ You can't `Ctrl+C` the agent anymore — kill via systemctl
  ✗ TUI not directly visible; debug via `tmux attach -t cookiedclaw`
    (or `journalctl --user -fu cookiedclaw` for raw logs)

Linux + systemd only. macOS users: the wizard exits, see launchd notes
in the README.
```

## Step 1 — Pre-flight checks

Run all of these and fail fast if anything is missing. Do not patch around — surface the problem.

```bash
# Linux check
uname -s
# Expect: Linux

# systemd check
command -v systemctl
# Expect: a path (typically /usr/bin/systemctl)

# tmux check (preferred TTY wrapper)
command -v tmux

# script(1) fallback if no tmux
command -v script
```

If neither tmux nor script(1) is available, abort: tell the user to `apt install tmux` (Debian/Ubuntu/Pi) or `dnf install tmux` (Fedora) and re-run the wizard.

If on macOS or another non-Linux: stop here, tell the user this wizard is Linux-only.

### Already-running ad-hoc claude

A live `claude` session polling the same bot token would 409-conflict with the daemon. The wizard runs **inside** the very claude process it's looking for, so naive `pgrep` will always match self. Use a count-based check instead — if the count is greater than 1, a second copy is running and we abort:

```bash
COUNT="$(pgrep -af 'claude.*plugin:cookiedclaw' | wc -l)"
if [ "$COUNT" -gt 1 ]; then
  echo "Another cookiedclaw claude process is running. Exit it first, then re-run /cookiedclaw:enable-daemon." >&2
  exit 1
fi
```

This is unambiguous: 1 = just us, the wizard is fine to proceed; >1 = at least one other process exists, abort.

### Existing unit from a different workspace

If `~/.config/systemd/user/cookiedclaw.service` already exists, read it and check whether its `WorkingDirectory=` (or the cd path baked into the launcher it points at) matches the current `pwd`. If they differ, **abort** and tell the user:

> A `cookiedclaw.service` unit already exists pointing at a different workspace. The default unit name only holds one workspace at a time. To run multiple cookiedclaw daemons, use a templated unit (`cookiedclaw@<workspace>.service`) — that's a follow-up, not part of this wizard yet.

Do not silently overwrite their other workspace's daemon.

## Step 2 — Workspace path

Capture the absolute path of the current workspace:

```bash
WORKSPACE="$(pwd)"
```

Store this — the launcher will hardcode it via heredoc. If `$WORKSPACE/.cookiedclaw/keys.env` doesn't exist, gently confirm with the user that this really is the workspace they want as the daemon's home — that file is the unambiguous "this is a cookiedclaw workspace" marker.

## Step 3 — Linger

systemd user services die when the user logs out unless linger is enabled.

```bash
loginctl enable-linger "$(id -un)"
```

This is idempotent. **Verify it actually took** — over SSH without an auth-agent, polkit can silently refuse:

```bash
loginctl show-user "$(id -un)" --property=Linger
```

If the output is anything other than `Linger=yes`, abort and tell the user to either run the wizard from a local TTY or set up SSH `auth-agent` forwarding so polkit can prompt them.

## Step 4 — Launcher script

Pick the launcher template by which TTY wrapper is available (tmux preferred, script(1) fallback). Write it to `~/.cookiedclaw/launcher.sh` using a heredoc — single substitution of `${WORKSPACE}`, no manual placeholder editing:

```bash
mkdir -p "$HOME/.cookiedclaw"

# tmux variant
cat > "$HOME/.cookiedclaw/launcher.sh" <<EOF
#!/usr/bin/env bash
# cookiedclaw daemon launcher — generated by /cookiedclaw:enable-daemon
set -euo pipefail
WORKSPACE='${WORKSPACE}'
SESSION='cookiedclaw'

cd "\$WORKSPACE"

# Tear down any stale tmux session from a prior run, then start fresh.
tmux kill-session -t "\$SESSION" 2>/dev/null || true
tmux new-session -d -s "\$SESSION" \\
  'claude --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw'

# Block while the tmux session is alive — systemd wants a long-running
# foreground process. When the session dies (claude exits / crashes),
# this loop ends and systemd applies its Restart= policy.
while tmux has-session -t "\$SESSION" 2>/dev/null; do
  sleep 5
done
EOF

chmod 700 "$HOME/.cookiedclaw/launcher.sh"
```

If tmux is unavailable and `script(1)` is the fallback, swap the `tmux …` block for:

```bash
cat > "$HOME/.cookiedclaw/launcher.sh" <<EOF
#!/usr/bin/env bash
# cookiedclaw daemon launcher (script(1) fallback) — generated by /cookiedclaw:enable-daemon
set -euo pipefail
WORKSPACE='${WORKSPACE}'

cd "\$WORKSPACE"
exec script -qfc \\
  'claude --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw' \\
  /dev/null
EOF

chmod 700 "$HOME/.cookiedclaw/launcher.sh"
```

`chmod 700` is intentional — the workspace path baked into the script is mildly information-leak-y on a multi-user box; defense in depth is cheap here.

## Step 5 — systemd unit

Write `~/.config/systemd/user/cookiedclaw.service`:

```ini
[Unit]
Description=cookiedclaw — Claude Code Telegram channel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Workspace path exposed via Environment so /cookiedclaw:daemon-status
# can read it back via `systemctl show --property=Environment` instead
# of grepping the launcher script. Substitute ${WORKSPACE} when writing.
Environment=WORKSPACE=${WORKSPACE}
ExecStart=%h/.cookiedclaw/launcher.sh
Restart=always
RestartSec=5
# CC sometimes takes a moment to start polling Telegram
TimeoutStartSec=30
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

`mkdir -p ~/.config/systemd/user/` if needed.

## Step 6 — Reload systemd, enable

```bash
systemctl --user daemon-reload
systemctl --user enable cookiedclaw
```

Do **not** `start` here — that would collide with the user's currently-running ad-hoc `claude` (Step 1 already refused if it found one, but the user might launch it again between then and now; safer to keep `start` an explicit user act).

## Step 7 — Tell the user how to switch over

Send this verbatim:

```
Daemon installed but not started yet.

To switch over from your current ad-hoc claude:

  1. In the terminal running `claude` right now, press
     Ctrl+C twice to exit.
  2. From any terminal: `systemctl --user start cookiedclaw`
  3. DM the bot — Cookie should respond from inside the daemon.

After this: future restarts go through `/cookiedclaw:daemon-restart`
from Telegram. Live-watch: `tmux attach -t cookiedclaw`.
Logs: `journalctl --user -fu cookiedclaw`.

Roll back: `systemctl --user disable --now cookiedclaw`
and resume launching `claude` by hand.
```

## Notes for you (the agent)

- This wizard is destructive in the sense that it changes how cookiedclaw boots. `disable-model-invocation: true` enforces explicit user invocation.
- Hard-coding the workspace path into the launcher via heredoc is intentional — single source of truth, no manual placeholder substitution that the model could mis-edit.
- Multiple workspaces require a templated unit (`cookiedclaw@<name>.service` with `WorkingDirectory=%i`). That's a follow-up, not this wizard.
