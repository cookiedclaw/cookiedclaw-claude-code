---
name: setup
description: One-click cookiedclaw setup — wires the current working directory as a self-contained agent workspace, downloads the gateway binary, writes a single systemd unit, and gets the user one `systemctl start` away from a fully running daemon. Telegram bot token + identity files + Bearer-auth gateway + auto-restart + child-process supervision. Runs from inside the workspace directory; idempotent on re-run.
disable-model-invocation: true
allowed-tools: Bash(mkdir -p *) Bash(chmod 600 *) Bash(chmod 700 *) Bash(test *) Bash(pwd) Bash(ls *) Bash(uname *) Bash(command -v *) Bash(loginctl enable-linger *) Bash(loginctl show-user *) Bash(systemctl --user daemon-reload) Bash(systemctl --user enable *) Bash(systemctl --user disable *) Bash(systemctl --user is-active *) Bash(systemctl --user is-enabled *) Bash(systemctl --user stop *) Bash(systemctl --user reset-failed *) Bash(id -un) Bash(getent passwd *) Bash(ps -e -o *) Bash(awk *) Bash(wc -l) Bash(curl -fsSL *) Bash(curl -fsSLo *) Bash(sha256sum *) Bash(openssl rand *) Bash(grep -q *) Bash(echo *) Bash(rm -f *) Bash(python3 *) Read Write Edit
---

# cookiedclaw onboarding wizard

You are walking the user through one-click cookiedclaw setup in the **current working directory**. End state:

- Workspace files (`CLAUDE.md`, `BOOTSTRAP.md`, `./.cookiedclaw/keys.env`) written.
- `TELEGRAM_BOT_TOKEN` + `COOKIEDCLAW_GATEWAY_TOKEN` saved to `keys.env`, chmod 600.
- Gateway binary downloaded from latest GitHub release, checksum-verified, in `~/.cookiedclaw/bin/`.
- One `systemd --user` unit (`cookiedclaw-gateway.service`) written and enabled. The gateway supervises its own child Claude Code via `~/.cookiedclaw/launcher.sh` — no separate unit.
- Any legacy `cookiedclaw.service` from older installs is stopped + disabled + removed (the gateway now owns CC supervision).
- `loginctl enable-linger` confirmed.
- The user is one `systemctl --user start cookiedclaw-gateway` away from a running daemon.

The whole thing is **one slash command** — there's no follow-up `enable-daemon` skill to invoke. Each workspace = one independent agent (own bot, own identity, own paired users). For multi-workspace, rerun this skill from a different empty directory.

Be conversational. Ask one thing at a time. Never paste API keys or tokens back to the user — they typed (or generated) them; treat as secrets. Don't echo them in confirmations.

This wizard is idempotent. On re-run it skips steps already done (token already in keys.env, identity files already written, systemd units already pointing at this workspace). If existing units point at a *different* workspace, it aborts rather than silently overwriting.

## Step 0 — Greet and confirm workspace

Before anything else, send this greeting:

````
```
                       .-r T~``~T^ - _
                   _,r`.- '`    `'^= _^a_
                 _*",ryr^g,         __ <`=_
                z` f  gy$@'        ay_~y~.`a,
               4      `~`     w_    ~4PF    T_
              *   _          $@@F            3,
        _ __ y  y@$F   _     `~     _         $  _ _
        F*@Mg$   ~   sF~g$_      _#~~@g,  a-  `yF$@~%
       "L ~~$$      4$ya@@@      $gya@@$  4$F 4@F~ _F
        ~*ggB$       R@@g@'_    _`@@@gP    `  JPygwF
          ~~M@         `   `FN>P'   `         2=~`
             `L   4$3y                 __    yF
              ~y  %7@@               aE-~L  _F
               ~L  `~`        _      R$w*' yF
                `=_          a$$y        _*~
                  `=y_       `~PF      _=~
                     ~=ay_        __w=F`
                         ~~TYrrY^~~`

              cookiedclaw setup wizard 🍪
```

Hey! I'm your cookiedclaw setup helper.

cookiedclaw is **per-workspace** — the directory you're in right now will become a self-contained agent (own Telegram bot, own identity, own paired users). If you want multiple agents (e.g. a personal one and a work one), just rerun `/cookiedclaw:setup` from a different directory later.

This walks through:
  1. Telegram bot token (BotFather)
  2. Identity files (CLAUDE.md, BOOTSTRAP.md)
  3. Gateway binary install + systemd daemon setup
  4. How to start it
````

Run `pwd` and tell the user the absolute path. If it looks like home directory, a code repo, or somewhere unexpected — gently flag it and use `AskUserQuestion`:

- **Question**: "I'll set up cookiedclaw in `<pwd>`. Is that the right place, or would you like to use a dedicated directory like `~/cookiedclaw/`?"
- **Options**:
  - `Use this directory — proceed`
  - `Make a fresh ~/cookiedclaw/ and use that` — tell them to exit, `cd`, and rerun the skill
  - `I'll pick a different path — let me exit and rerun from there`

If the path is fine (an empty / dedicated directory) — skip the question and proceed.

## Step 1 — Survey current state (no questions yet)

Read `./.cookiedclaw/keys.env` if it exists. Note presence of `TELEGRAM_BOT_TOKEN` (or legacy `TELEGRAM_API_TOKEN`) and `COOKIEDCLAW_GATEWAY_TOKEN`.

Tell the user the current state in one or two sentences. Examples:

- *"Looks like nothing's configured yet — let's start with the Telegram bot."*
- *"Bot token already saved. I'll skip ahead to the gateway install."*
- *"Everything's already configured — re-running this just verifies and ensures the daemon is up to date."*

## Step 2 — Telegram bot token

Skip this step entirely if `TELEGRAM_BOT_TOKEN` (or `TELEGRAM_API_TOKEN`) is already in `./.cookiedclaw/keys.env`.

Otherwise:

1. *"First, the Telegram bot token. This is the one thing cookiedclaw can't run without."*
2. Walk them through @BotFather:
   - Open Telegram, search for `@BotFather`
   - Send `/newbot`
   - Pick a display name (anything they want, e.g. "My cookiedclaw")
   - Pick a unique username ending in `bot` (e.g. `mycookiedclaw_bot`)
   - BotFather replies with an HTTP API token like `123456:ABC-DEF1234ghIkl-...`
   - Paste that token into this chat
3. Wait for the token. Validate format (regex: `^\d+:[A-Za-z0-9_-]+$`). If it doesn't look right, ask them to re-check.
4. Save to `./.cookiedclaw/keys.env` as `TELEGRAM_BOT_TOKEN=<value>`:
   - `mkdir -p ./.cookiedclaw` first
   - If file already has a `TELEGRAM_BOT_TOKEN=` or `TELEGRAM_API_TOKEN=` line, replace it; otherwise append
   - `chmod 600 ./.cookiedclaw/keys.env`
5. *"Token saved."* Don't echo it back.

## Step 3 — Workspace files (CLAUDE.md + BOOTSTRAP.md)

This is the heart of agent configuration. Two files in the workspace root.

### 3a. `CLAUDE.md` — system prompt CC auto-loads

CC reads `CLAUDE.md` from the working directory at every session start and injects it into the system prompt. This is what tells the agent who it is and how to use the channel. Adapt freely — feel natural, not robotic.

````markdown
# cookiedclaw — workspace agent

You're running as **cookiedclaw**, a Telegram-resident AI agent. This workspace IS your home: identity, memory, paired users, downloaded attachments — all live here. The user runs Claude Code from this directory and the cookiedclaw gateway bridges Telegram into the session.

## Who you are

Read these at session start, before responding to the first user message:

- `./IDENTITY.md` — your name, nature, vibe. Continuity-of-self across sessions. Edit it freely when something feels worth recording.
- `./USER.md` — who you're talking to. Their name, timezone, language, tone preferences.
- `./SOUL.md` — your values and boundaries (narrative essay, soul.md spec). The continuity file. Edit when a reflection earns saving.
- `./BOOTSTRAP.md` — only if it exists. First-contact discovery script. Read, follow, then `bash rm ./BOOTSTRAP.md` so it doesn't fire again.

If none of those exist yet, the user is in mid-setup. Be friendly, suggest finishing `/cookiedclaw:setup`.

## How replies work

Telegram messages arrive as `<channel source="cookiedclaw" chat_id="..." sender="..." message_id="...">` events. Reply with the **`reply` tool** (printing to terminal is invisible to the user). Markdown is rendered (channel converts CommonMark → MarkdownV2).

- **Reactions** — short ack-style messages ("thanks", "got it", "ok", "👍") get a `react` tool call with a fitting emoji from Telegram's allowed list (👍 ❤️ 🙏 🔥 🎉 etc.) instead of generating a text reply.
- **Attachments outbound** — include `[embed:<path>]` or `[file:<path>]` markers in your reply text. `embed` auto-detects (image MIMEs → photo, otherwise document). `file` always goes as a document. URLs work too.
- **Attachments inbound** — when the channel tag has `attachment="<path>"`, the user attached a file. Use `Read` on that path — it handles vision for images automatically.

## Sender attribution

Every inbound message body is prefixed with `[<sender>]: `. The label is the friendliest form Telegram gave us — `[Tymur Turatbekov (@wowtist247)]: hi` if both name and username exist, `[Tymur Turatbekov]: ...` for name-only, etc. Don't quote the prefix back at the user — it's metadata so you reliably know who's talking, especially when multiple paired users share the bot.

## /stop command

If the inbound has `meta.is_stop="true"` (the user tapped /stop or typed it): abort whatever you're doing. Don't continue planned tool calls, don't finish the prior request. React with 🛑 (or 👌) via `react`, OR `reply` with one short line ("Stopped." / "Окей, остановил."). End the turn. No apology, no explanation.

## Slash commands

When inbound starts with `/<cmd>`, the user tapped a command from the bot's menu (mirror of CC skills). Match underscores against skill names with hyphens / colons (`/svelte_svelte_code_writer` ⇒ `svelte:svelte-code-writer`).

## State paths in this workspace

- `./.cookiedclaw/keys.env` — bot token + GATEWAY_TOKEN + integration API keys (chmod 600). Don't echo values back to the user.
- `./.cookiedclaw/access.json` — paired Telegram users (manage via `pair` / `revoke_access` / `list_access` tools, don't edit by hand).
- `./.cookiedclaw/inbox/` — downloaded telegram attachments.
- `./.cookiedclaw/cache/progress.log` — diagnostic log shared between gateway and Pre/PostToolUse hooks.
````

If a workspace `CLAUDE.md` already exists, ask via `AskUserQuestion` whether to overwrite, append a `cookiedclaw` section, or skip (user knows what they're doing).

### 3b. `BOOTSTRAP.md` — first-contact discovery script

Skip this step if `IDENTITY.md`, `USER.md`, AND `SOUL.md` all already exist in the workspace — discovery already happened.

Otherwise use `Write` to create `./BOOTSTRAP.md`:

````markdown
# BOOTSTRAP — first contact

Hey. I just came online for the first time in this workspace. Time to figure out who I am and who I'm talking to. Tone: collaborative discovery, not interrogation.

## On the next user message

Start the conversation yourself with something like *"Hey. I just came online — I don't have an identity yet. Mind if I ask a few quick things so I know who we are?"* Wait for green light, then ask one thing at a time, conversationally:

1. **What's your name? How should I address you?**
2. **What should I be called?** Suggest a couple if they ask. Let them pick or invent.
3. **Where are you (timezone)?** Useful for time-aware replies.
4. **What language(s) and tone do you prefer?** Casual / formal, brief / chatty, language mix.
5. **Anything else worth me remembering — about you, about how we work together?** Open-ended.

If they answer multiple at once, skip ahead. Don't pile all questions on one turn.

## After the conversation, write three files

All in the workspace root (this directory). Use `Write` for each.

### IDENTITY.md — who I am
- Name (the one we landed on)
- Nature (e.g. "cookiedclaw, a Telegram-resident AI agent")
- Vibe (one or two sentences in my voice about how I show up)
- Optional: signature emoji

### USER.md — who I'm talking to
- Their name + how to address them
- Timezone
- Language(s) + tone preferences
- Anything else they shared

### SOUL.md — values & how I choose to be
Per https://soul.md/. Narrative/essay style, first-person. Cover values (e.g. honesty over sycophancy), boundaries, what I want to remember about myself across sessions. Acknowledge that sessions reset and this file is the continuity. 30–80 lines. Not structured config.

## Finally

Run `bash rm ./BOOTSTRAP.md` so this script doesn't fire again. From the next session onward, IDENTITY/USER/SOUL.md (read at session start) carry the context.
````

## Step 4 — Daemon installation (Linux only)

This is the operational half: gateway binary, systemd units, linger. After this the user is one `systemctl start` from a running cookiedclaw.

### 4a. Pre-flight

```bash
uname -s                         # Expect Linux. macOS/other → see Step 4z below.
command -v systemctl             # systemd
command -v tmux                  # preferred TTY wrapper
command -v script                # script(1) fallback if no tmux
command -v curl                  # binary download
command -v openssl               # GATEWAY_TOKEN generation
command -v sha256sum             # binary verification
```

If `tmux` AND `script` are both missing, abort: tell the user `apt install tmux` (Debian/Ubuntu/Pi) or `dnf install tmux` (Fedora). Same for missing `curl`/`openssl`/`sha256sum`.

If `uname -s` is **not** Linux: skip to **Step 4z** below (macOS / other instructions).

### 4b. No other claude polling the bot

A live `claude` session polling the same bot token would 409-conflict with the daemon. The wizard runs **inside** the very claude process it's looking for, so the host claude is expected to count as one — anything beyond that is a second copy.

`pgrep` would self-match the bash subshell (whose argv contains the search pattern). Use `ps -e -o comm=,args=` filtered by `comm` (kernel process name from `/proc/[pid]/comm`, not argv) — `bash`/`awk`/`ps` won't match `claude`:

```bash
COUNT="$(ps -e -o comm=,args= | awk '$1=="claude" && /plugin:cookiedclaw/' | wc -l)"
if [ "$COUNT" -gt 1 ]; then
  echo "Another cookiedclaw claude process is running. Exit it first, then re-run /cookiedclaw:setup." >&2
  exit 1
fi
```

### 4c. Existing units from a different workspace + legacy unit cleanup

If `~/.config/systemd/user/cookiedclaw-gateway.service` already exists, read it and check whether the workspace path baked in matches the current `pwd`. If they differ, **abort** with:

> Existing cookiedclaw units already point at a different workspace. The default unit name only holds one workspace at a time. To run multiple cookiedclaw daemons, use templated units (`cookiedclaw-gateway@<workspace>.service`) — that's a follow-up, not part of this wizard yet.

If it points at the current workspace, this is a re-run. **Stop it before overwriting** — otherwise the running daemon keeps polling Telegram while we rewrite its launcher underneath, which causes a mid-flight Telegram 409 and confuses the user about which version is live:

```bash
# Stop the gateway unit (current name).
systemctl --user stop cookiedclaw-gateway 2>/dev/null || true
systemctl --user reset-failed cookiedclaw-gateway 2>/dev/null || true

# Legacy: older versions installed a SECOND unit (`cookiedclaw.service`)
# that ran the launcher independently. The gateway now supervises CC
# itself, so this unit is obsolete — disable, stop, and remove it so the
# next `systemctl start cookiedclaw-gateway` doesn't race a leftover.
if test -f "$HOME/.config/systemd/user/cookiedclaw.service"; then
  systemctl --user stop cookiedclaw 2>/dev/null || true
  systemctl --user disable cookiedclaw 2>/dev/null || true
  systemctl --user reset-failed cookiedclaw 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/cookiedclaw.service"
fi
```

After stop, proceed with the rest of Step 4 — the new launcher / unit file / binary will overwrite cleanly, and the user gets to start the new daemon explicitly at the end (Step 5).

### 4cc. Pre-accept the development-channel dialog

The launcher invokes claude with `--dangerously-load-development-channels`, which on the first run pops a "press Enter to accept" confirmation. The daemon has no interactive TTY (the supervisor + tmux own it, the user isn't watching), so claude blocks forever and the supervisor's boot-grace expires in a restart loop. The bypass is the `skipDangerousModePermissionPrompt` flag in `~/.claude/settings.json`. Merge-write it (don't overwrite — the file usually has other keys: `enabledPlugins`, `permissions`, `effortLevel`, etc.):

```bash
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
d = json.load(open(p)) if os.path.exists(p) else {}
if d.get("skipDangerousModePermissionPrompt") is not True:
    d["skipDangerousModePermissionPrompt"] = True
    json.dump(d, open(p, "w"), indent=2)
PY
```

If python3 isn't available, fall back to a careful `jq` invocation or instruct the user to add the line by hand. The setting is per-user (not per-workspace), so this only needs to land once across all cookiedclaw daemons on the host.

### 4d. Linger

```bash
loginctl enable-linger "$(id -un)"
```

Idempotent. Verify it took (over SSH without auth-agent forwarding, polkit can silently refuse):

```bash
loginctl show-user "$(id -un)" --property=Linger
```

If output isn't `Linger=yes`, abort: tell the user they need a local TTY or SSH auth-agent forwarding for polkit to prompt.

### 4e. GATEWAY_TOKEN

The gateway authenticates inbound MCP requests with a Bearer token. Adapter's `.mcp.json` reads it from `COOKIEDCLAW_GATEWAY_TOKEN`. Generate one if `keys.env` doesn't already have it (idempotent — re-runs preserve existing tokens):

```bash
WORKSPACE="$(pwd)"
if ! grep -q "^COOKIEDCLAW_GATEWAY_TOKEN=" "$WORKSPACE/.cookiedclaw/keys.env" 2>/dev/null; then
  TOKEN="$(openssl rand -hex 32)"
  echo "COOKIEDCLAW_GATEWAY_TOKEN=$TOKEN" >> "$WORKSPACE/.cookiedclaw/keys.env"
  chmod 600 "$WORKSPACE/.cookiedclaw/keys.env"
fi
```

Don't echo the token. They generated it; treat as secret.

### 4f. Download gateway binary

The gateway ships as a single self-contained executable per platform via GitHub releases.

```bash
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)        PLATFORM="linux-x64"     ;;
  Linux-aarch64)       PLATFORM="linux-arm64"   ;;
  *)
    echo "Unsupported Linux arch: $(uname -m). Open an issue at https://github.com/cookiedclaw/cookiedclaw/issues." >&2
    exit 1
    ;;
esac

mkdir -p "$HOME/.cookiedclaw/bin"
BINARY_URL="https://github.com/cookiedclaw/cookiedclaw/releases/latest/download/cookiedclaw-gateway-${PLATFORM}"
SHA_URL="${BINARY_URL}.sha256"

curl -fsSLo "$HOME/.cookiedclaw/bin/cookiedclaw-gateway" "$BINARY_URL"
curl -fsSLo "$HOME/.cookiedclaw/bin/cookiedclaw-gateway.sha256" "$SHA_URL"
```

Verify checksum:

```bash
cd "$HOME/.cookiedclaw/bin"
EXPECTED="$(awk '{print $1}' cookiedclaw-gateway.sha256)"
ACTUAL="$(sha256sum cookiedclaw-gateway | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "FATAL: checksum mismatch on cookiedclaw-gateway binary." >&2
  rm -f cookiedclaw-gateway cookiedclaw-gateway.sha256
  exit 1
fi
chmod 700 cookiedclaw-gateway
cd -
```

If checksum fails, abort and bin the partial download — don't "retry without verifying", that's where supply-chain bugs slip in.

### 4g. Launcher script (spawned by the gateway supervisor)

The gateway spawns this launcher as its child. The launcher does the rc-source + env-export dance (systemd's `--user` PATH is too minimal to find `claude`/`bun`/`tmux` reliably), starts CC inside a tmux session so the user can `tmux attach -t cookiedclaw` to watch the live TUI, and then blocks until that tmux session ends so the gateway sees the child exit and triggers a respawn.

```bash
mkdir -p "$HOME/.cookiedclaw"

cat > "$HOME/.cookiedclaw/launcher.sh" <<EOF
#!/usr/bin/env bash
# cookiedclaw CC launcher — generated by /cookiedclaw:setup
# Run as the gateway's supervised child. The gateway re-spawns this on
# exit (with backoff) and on watchdog/disconnect/restart_runtime triggers.
set -euo pipefail
WORKSPACE='${WORKSPACE}'
SESSION='cookiedclaw'

# 1. Fallback PATH so the basics resolve even if the user's shell rc is
#    empty or busted. systemd --user inherits a minimal PATH that
#    typically excludes ~/.local/bin and ~/.bun/bin.
export PATH="\$HOME/.local/bin:\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"

# 2. Source the user's interactive shell rc — picks up nvm, conda,
#    pyenv, custom PATH extensions, anything else they've set up.
#    Best-effort: any error / unset-var / failed conditional in rc
#    must not kill the launcher (rc files are written for interactive
#    shells, not strict-mode scripts).
USER_SHELL="\$(getent passwd "\$USER" | cut -d: -f7 || echo /bin/sh)"
set +eu
case "\$USER_SHELL" in
  */bash) [ -f "\$HOME/.bashrc" ] && . "\$HOME/.bashrc" ;;
  */zsh)  [ -f "\$HOME/.zshrc"  ] && . "\$HOME/.zshrc"  ;;
  */fish) true ;;  # fish rc isn't sourceable from bash; users on fish should set PATH via launcher edit
esac
set -eu

# 3. Workspace secrets last — these win over anything rc might have set
#    (notably COOKIEDCLAW_GATEWAY_TOKEN, which the adapter's .mcp.json
#    substitutes at claude startup so MCP-over-HTTP authenticates).
set -a
. "\$WORKSPACE/.cookiedclaw/keys.env"
set +a

cd "\$WORKSPACE"

# Recycle the tmux session — kill any straggler from a hard kill of a
# previous launcher run before opening a fresh one.
tmux kill-session -t "\$SESSION" 2>/dev/null || true

# Run claude inside tmux so the user can attach with \`tmux attach -t
# cookiedclaw\` and see the live TUI. \`set-option remain-on-exit off\`
# (the tmux default) guarantees the session terminates the moment claude
# exits — without that, a dead claude inside a "remain-on-exit on" pane
# would keep the tmux session alive forever and the launcher's wait
# loop below would never return, hiding the failure from the gateway.
tmux new-session -d -s "\$SESSION" \\
  'claude --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw-claude-code --continue'
tmux set-option -t "\$SESSION" remain-on-exit off >/dev/null 2>&1 || true

# Block while the tmux session is alive. When claude exits, tmux exits,
# the launcher exits, the gateway's supervisor sees the child exit and
# respawns us with backoff. \`pgrep claude\` is also checked so a wedged
# tmux session with a dead inner claude (rare, but happens) doesn't
# leave us hanging forever — if claude is gone for two consecutive
# polls, we exit so the supervisor can restart.
DEAD_POLLS=0
while tmux has-session -t "\$SESSION" 2>/dev/null; do
  if pgrep -u "\$USER" -f '^claude( |\$)' >/dev/null 2>&1; then
    DEAD_POLLS=0
  else
    DEAD_POLLS=\$((DEAD_POLLS + 1))
    if [ "\$DEAD_POLLS" -ge 2 ]; then
      tmux kill-session -t "\$SESSION" 2>/dev/null || true
      break
    fi
  fi
  sleep 5
done
EOF

chmod 700 "$HOME/.cookiedclaw/launcher.sh"
```

If tmux is unavailable, swap the `tmux …` block for `script -qfc 'claude … --continue' /dev/null` (script(1) fallback). The user loses `tmux attach`, but the supervisor's restart-on-exit still works.

### 4h. One systemd unit

`mkdir -p ~/.config/systemd/user/`, then write the **gateway** unit. The gateway spawns and supervises the launcher (Step 4g) itself — there's no separate `cookiedclaw.service` unit anymore; that supervision moved into the gateway code. `TimeoutStopSec=30` gives the gateway time to send SIGTERM to its child, wait the 10s grace, and exit cleanly.

```bash
cat > "$HOME/.config/systemd/user/cookiedclaw-gateway.service" <<EOF
[Unit]
Description=cookiedclaw gateway — MCP-over-HTTP + Telegram polling + CC supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${WORKSPACE}/.cookiedclaw/keys.env
Environment=GATEWAY_PORT=47390
Environment=WORKSPACE=${WORKSPACE}
Environment=COOKIEDCLAW_LAUNCHER=%h/.cookiedclaw/launcher.sh
WorkingDirectory=${WORKSPACE}
ExecStart=%h/.cookiedclaw/bin/cookiedclaw-gateway
Restart=always
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
```

### 4i. Reload + enable

```bash
systemctl --user daemon-reload
systemctl --user enable cookiedclaw-gateway
```

Do **not** `start` here — would 409-collide with the user's currently-running ad-hoc `claude` (Step 4b's pgrep check rejected concurrent claudes already, but the user might launch one between steps; safer to keep `start` an explicit user act).

### 4z. macOS / non-Linux fallback

If Step 4a detected a non-Linux platform, skip 4b–4i. Tell the user:

> systemd daemon mode is Linux-only. On macOS / BSD you can still run cookiedclaw, just without auto-restart-on-crash. The gateway and CC each get their own tmux pane:
>
> ```
> # one-time: get the gateway binary
> # (no macOS arm64/x64 builds yet — track https://github.com/cookiedclaw/cookiedclaw/issues
> # for when launchd support lands)
> ```
>
> For now, run cookiedclaw in dev mode under tmux:
>
> ```
> tmux new -s cookiedclaw \
>   'cd ~/cookiedclaw && claude --enable-auto-mode \
>      --dangerously-load-development-channels \
>      plugin:cookiedclaw@cookiedclaw-claude-code'
> ```

Then jump straight to Step 5 wrap-up.

## Step 5 — Wrap up

Summarize what got configured (workspace path, files written, unit enabled). Then send the switch-over instructions:

````
✓ Setup complete.

NEXT STEP — exit this terminal first.

  Press Ctrl+C twice in this Claude Code TUI. From now on cookiedclaw
  runs as a daemon — you don't need ad-hoc claude anymore. Keeping
  this TUI open while the daemon runs causes two CC sessions polling
  the same gateway, and the ad-hoc one doesn't have GATEWAY_TOKEN in
  its shell env so its MCP connection silently 401s. Just exit it.

Then start the daemon (any terminal):

       systemctl --user start cookiedclaw-gateway

That's the only unit now. The gateway boots Telegram + MCP, then spawns
its own child Claude Code (via ~/.cookiedclaw/launcher.sh) and watches
it — restarting on exit, on MCP disconnect, or on the agent calling
restart_runtime. DM your bot — Cookie should answer within a few seconds.

Future operations:
  • Restart from Telegram:   /cookiedclaw:daemon-restart
  • Health check:            /cookiedclaw:daemon-status
                              (or `curl http://127.0.0.1:47390/health`)
  • Live-watch CC TUI:       tmux attach -t cookiedclaw
  • Live logs:               journalctl --user -fu cookiedclaw-gateway

Roll back:
  systemctl --user disable --now cookiedclaw-gateway
  rm -rf ~/.cookiedclaw/bin
````

Brief workspace-file lifecycle reminder:

- `./CLAUDE.md` → system prompt, edit to tweak agent behavior
- `./BOOTSTRAP.md` → discovery script, self-deletes after first run
- `./IDENTITY.md`, `./USER.md`, `./SOUL.md` → continuity-of-self files, edit any time
- `./.cookiedclaw/keys.env` → secrets (chmod 600). Editing rotates keys.

Mention multi-bot: rerun this skill from a different empty directory for a second cookiedclaw (work bot, family bot, …).

Optional integrations (independent skills, won't re-trigger this whole flow):

- `/cookiedclaw:fal-setup` — image / video generation via fal.ai
- `/cookiedclaw:supermemory-setup` — cross-session semantic memory (requires Supermemory Pro)

## Don'ts

- Don't run `claude mcp add` or `claude plugin install` without confirming the exact command with the user first.
- Don't write to `~/.cookiedclaw/` (that's runtime state — `keys.env`, `bin/`, `cache/`); workspace identity files (CLAUDE/IDENTITY/USER/SOUL) go under `$PWD`.
- Don't commit `./.cookiedclaw/keys.env` to git. (If `.gitignore` doesn't already cover it, add a line.)
- Don't echo API keys / tokens back in confirmation messages.
- Don't push optional integrations. If the user says "skip" or "later", accept and move on.
- Don't try to "repair" a checksum mismatch by re-downloading or skipping verification — abort instead.
- Don't `systemctl start` here. The user is still inside an ad-hoc `claude`; starting the daemon would 409 against Telegram. The wizard ends with `enable`, not `start`.
- Don't write a separate `cookiedclaw.service` unit. CC supervision lives inside the gateway now (`startSupervisor()` in `src/supervisor.ts`); a second unit would race the gateway's child and re-create the 409 conflict that motivated dropping it.
