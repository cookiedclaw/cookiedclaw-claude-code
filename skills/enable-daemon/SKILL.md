---
name: enable-daemon
description: One-time onboarding wizard. Downloads the cookiedclaw gateway binary from GitHub releases, generates a Bearer token, writes two systemd --user units (gateway + CC daemon), and tells the user how to start them. After this, cookiedclaw survives logout, reboots, and crashes — and the agent can restart itself remotely from Telegram via /cookiedclaw:daemon-restart. Run once per workspace, from inside the workspace directory.
disable-model-invocation: true
allowed-tools: Bash(uname *) Bash(which *) Bash(command -v *) Bash(loginctl enable-linger *) Bash(loginctl show-user *) Bash(systemctl --user daemon-reload) Bash(systemctl --user enable *) Bash(systemctl --user is-active *) Bash(systemctl --user is-enabled *) Bash(mkdir -p *) Bash(test *) Bash(pwd) Bash(id -un) Bash(getent passwd *) Bash(ps -e -o *) Bash(awk *) Bash(wc -l) Bash(chmod 700 *) Bash(chmod 600 *) Bash(curl -fsSL *) Bash(curl -fsSLo *) Bash(sha256sum *) Bash(openssl rand *) Bash(grep -q *) Bash(echo *) Read Write Edit
---

# Going daemon

You are walking the user through converting their **current workspace** from a hand-launched `claude --dangerously-load-development-channels …` into a `systemd --user`-managed daemon. After this:

- A `cookiedclaw-gateway` binary lives at `~/.cookiedclaw/bin/` and runs as `cookiedclaw-gateway.service`. It owns Telegram polling and the MCP-over-HTTP server.
- A separate `cookiedclaw.service` unit runs Claude Code in a tmux session, with the adapter pointing at the gateway over HTTP.
- Both auto-restart on crash, survive logout (linger), and start on boot.

The user never touches the terminal to restart again. Cookie can do it from Telegram via `/cookiedclaw:daemon-restart`.

## Step 0 — Greet, name the trade-offs

Send this so the user knows what's about to happen:

```
Going daemon mode. After this:

  ✓ cookiedclaw survives logout, reboots, crashes (auto-restart)
  ✓ Cookie can /cookiedclaw:daemon-restart itself from Telegram
  ✓ /cookiedclaw:install-skill works without you touching the terminal
  ✗ You can't `Ctrl+C` the agent anymore — kill via systemctl
  ✗ TUI not directly visible; debug via `tmux attach -t cookiedclaw`
    (or `journalctl --user -fu cookiedclaw cookiedclaw-gateway`)

Linux + systemd only. macOS users: the wizard exits, see launchd notes
in the README.
```

## Step 1 — Pre-flight checks

Run all of these and fail fast if anything is missing:

```bash
uname -s                                # expect Linux
command -v systemctl                    # expect a path
command -v tmux                         # preferred TTY wrapper
command -v script                       # script(1) fallback if no tmux
command -v curl                         # for downloading the binary
command -v openssl                      # for generating GATEWAY_TOKEN
command -v sha256sum                    # for verifying the binary
```

If any of `tmux` (or fallback `script`), `curl`, `openssl`, `sha256sum` is missing, abort with a one-line apt install hint and exit. Don't try to install for the user.

If on macOS or another non-Linux: stop, tell the user this wizard is Linux-only.

### Already-running ad-hoc claude

A live `claude` session polling the same bot token would 409-conflict with the daemon. The wizard runs **inside** the very claude process it's looking for, so the host claude is expected to count as one — anything beyond that is a second copy and we abort.

`pgrep` would self-match the bash subshell whose argv contains the search pattern. Use `ps -e -o comm=,args=` filtered by `comm` (kernel process name from `/proc/[pid]/comm`, not argv) — `bash`/`awk`/`ps` won't match `claude`:

```bash
COUNT="$(ps -e -o comm=,args= | awk '$1=="claude" && /plugin:cookiedclaw/' | wc -l)"
if [ "$COUNT" -gt 1 ]; then
  echo "Another cookiedclaw claude process is running. Exit it first, then re-run /cookiedclaw:enable-daemon." >&2
  exit 1
fi
```

### Existing units from a different workspace

If `~/.config/systemd/user/cookiedclaw.service` or `~/.config/systemd/user/cookiedclaw-gateway.service` already exists, read them and check whether their workspace paths match the current `pwd`. If they differ, **abort** and tell the user:

> Existing cookiedclaw units already point at a different workspace. The default unit names only hold one workspace at a time. To run multiple cookiedclaw daemons, use templated units (`cookiedclaw@<workspace>.service`) — that's a follow-up, not part of this wizard yet.

Do not silently overwrite a working setup from a different workspace.

## Step 2 — Workspace path

```bash
WORKSPACE="$(pwd)"
```

If `$WORKSPACE/.cookiedclaw/keys.env` doesn't exist, gently confirm with the user that this really is the workspace they want — that file is the unambiguous "this is a cookiedclaw workspace" marker (created by `/cookiedclaw:setup`).

## Step 3 — Linger

```bash
loginctl enable-linger "$(id -un)"
```

Idempotent. Verify it took (over SSH without auth-agent forwarding, polkit can silently refuse):

```bash
loginctl show-user "$(id -un)" --property=Linger
```

If output isn't `Linger=yes`, abort with the explanation that the user needs a local TTY or SSH auth-agent forwarding for polkit to prompt.

## Step 4 — GATEWAY_TOKEN

The gateway authenticates inbound MCP requests with a Bearer token. The adapter's `.mcp.json` reads it from `COOKIEDCLAW_GATEWAY_TOKEN`. We generate one if `keys.env` doesn't already have it (idempotent — re-running the wizard preserves an existing token):

```bash
if ! grep -q "^COOKIEDCLAW_GATEWAY_TOKEN=" "$WORKSPACE/.cookiedclaw/keys.env" 2>/dev/null; then
  TOKEN="$(openssl rand -hex 32)"
  echo "COOKIEDCLAW_GATEWAY_TOKEN=$TOKEN" >> "$WORKSPACE/.cookiedclaw/keys.env"
  chmod 600 "$WORKSPACE/.cookiedclaw/keys.env"
fi
```

Don't echo the token back to the user. They typed (or generated) it; treat it as a secret.

## Step 5 — Download the gateway binary

The gateway ships as a single self-contained executable per platform via GitHub releases.

Detect platform:

```bash
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)        PLATFORM="linux-x64"     ;;
  Linux-aarch64)       PLATFORM="linux-arm64"   ;;
  Darwin-arm64)        PLATFORM="darwin-arm64"  ;;
  Darwin-x86_64)       PLATFORM="darwin-x64"    ;;
  *)
    echo "Unsupported platform: $(uname -s)-$(uname -m). Open an issue at https://github.com/cookiedclaw/cookiedclaw/issues." >&2
    exit 1
    ;;
esac
```

Download the binary + checksum from the latest release (`releases/latest/download/<name>` is GitHub's standard latest-redirect):

```bash
mkdir -p "$HOME/.cookiedclaw/bin"
BINARY_URL="https://github.com/cookiedclaw/cookiedclaw/releases/latest/download/cookiedclaw-gateway-${PLATFORM}"
SHA_URL="${BINARY_URL}.sha256"

curl -fsSLo "$HOME/.cookiedclaw/bin/cookiedclaw-gateway" "$BINARY_URL"
curl -fsSLo "$HOME/.cookiedclaw/bin/cookiedclaw-gateway.sha256" "$SHA_URL"
```

Verify checksum (the release workflow generates these alongside each binary):

```bash
cd "$HOME/.cookiedclaw/bin"
# The .sha256 file's filename column references the binary name relative
# to where it was generated; regenerate locally and compare digests
# directly to keep the comparison robust to path differences.
EXPECTED="$(awk '{print $1}' cookiedclaw-gateway.sha256)"
ACTUAL="$(sha256sum cookiedclaw-gateway | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "FATAL: checksum mismatch on cookiedclaw-gateway binary." >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  rm -f cookiedclaw-gateway cookiedclaw-gateway.sha256
  exit 1
fi
chmod 700 cookiedclaw-gateway
cd -
```

If the checksum fails, the download was corrupted or tampered with — abort and bin the partial download.

## Step 6 — Launcher script (CC side)

The CC daemon launcher needs to inherit `COOKIEDCLAW_GATEWAY_TOKEN` so the adapter's `.mcp.json` substitution works. Source `keys.env` before exec'ing claude:

```bash
mkdir -p "$HOME/.cookiedclaw"

cat > "$HOME/.cookiedclaw/launcher.sh" <<EOF
#!/usr/bin/env bash
# cookiedclaw CC-daemon launcher — generated by /cookiedclaw:enable-daemon
set -euo pipefail
WORKSPACE='${WORKSPACE}'
SESSION='cookiedclaw'

# Inherit COOKIEDCLAW_GATEWAY_TOKEN (and any other workspace secrets)
# from keys.env so the adapter's .mcp.json placeholder substitution
# resolves at claude startup.
set -a
. "\$WORKSPACE/.cookiedclaw/keys.env"
set +a

# systemd --user services start with a minimal PATH. Inject common
# user-install bin dirs so claude (~/.local/bin) and any tools the
# session shells out to (~/.bun/bin) resolve.
export PATH="\$HOME/.local/bin:\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"

cd "\$WORKSPACE"

tmux kill-session -t "\$SESSION" 2>/dev/null || true
tmux new-session -d -s "\$SESSION" \\
  'claude --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw-claude-code --continue'

while tmux has-session -t "\$SESSION" 2>/dev/null; do
  sleep 5
done
EOF

chmod 700 "$HOME/.cookiedclaw/launcher.sh"
```

If tmux is unavailable, swap the `tmux` block for `script(1)` (same fallback as before — see prior version of this file in git history if needed).

## Step 7 — Two systemd units

`mkdir -p ~/.config/systemd/user/`, then write **gateway** unit:

```bash
cat > "$HOME/.config/systemd/user/cookiedclaw-gateway.service" <<EOF
[Unit]
Description=cookiedclaw gateway — MCP-over-HTTP + Telegram polling
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${WORKSPACE}/.cookiedclaw/keys.env
Environment=GATEWAY_PORT=47390
Environment=WORKSPACE=${WORKSPACE}
WorkingDirectory=${WORKSPACE}
ExecStart=%h/.cookiedclaw/bin/cookiedclaw-gateway
Restart=always
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
```

…and **CC daemon** unit (depends on the gateway being up):

```bash
cat > "$HOME/.config/systemd/user/cookiedclaw.service" <<EOF
[Unit]
Description=cookiedclaw — Claude Code session connected to the gateway
After=cookiedclaw-gateway.service network-online.target
Wants=cookiedclaw-gateway.service network-online.target
Requires=cookiedclaw-gateway.service

[Service]
Type=simple
Environment=WORKSPACE=${WORKSPACE}
ExecStart=%h/.cookiedclaw/launcher.sh
Restart=always
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
```

The `Requires=` + `After=` make systemd start the gateway first and stop the CC daemon if the gateway dies — the adapter is useless without the gateway anyway.

## Step 8 — Reload + enable

```bash
systemctl --user daemon-reload
systemctl --user enable cookiedclaw-gateway cookiedclaw
```

Do **not** `start` here — that would collide with the user's currently-running ad-hoc `claude` (Step 1's pgrep check rejected concurrent claudes already, but the user might launch one between steps; safer to keep `start` an explicit user act).

## Step 9 — Tell the user how to switch over

```
Daemon installed but not started yet.

To switch over from your current ad-hoc claude:

  1. In the terminal running `claude` right now, press
     Ctrl+C twice to exit.
  2. From any terminal:
       systemctl --user start cookiedclaw-gateway cookiedclaw
     (the gateway starts first; CC follows once it's up)
  3. DM the bot — Cookie should respond from inside the daemon.

After this:
  • Future restarts: /cookiedclaw:daemon-restart from Telegram
  • Live-watch CC TUI: tmux attach -t cookiedclaw
  • Live logs:
      journalctl --user -fu cookiedclaw-gateway
      journalctl --user -fu cookiedclaw

Roll back:
  systemctl --user disable --now cookiedclaw cookiedclaw-gateway
  rm -rf ~/.cookiedclaw/bin
```

## Notes for you (the agent)

- `disable-model-invocation: true` enforces explicit user invocation — this wizard rewrites how cookiedclaw boots and shouldn't fire on a heuristic.
- The token written to `keys.env` is sensitive. Never echo it back to the user, never include it in commit messages, never paste it into a Telegram reply. The chmod 600 on keys.env keeps it user-only.
- The downloaded binary is checksum-verified against the release artifact. If the checksum fails, abort — don't try to "repair" or "retry without verifying"; that's where supply-chain bugs slip in.
- Multiple workspaces require templated units (`cookiedclaw@<name>.service` with `WorkingDirectory=%i`). Out of scope for this wizard; tracked in https://github.com/cookiedclaw/cookiedclaw-claude-code/issues/2.
