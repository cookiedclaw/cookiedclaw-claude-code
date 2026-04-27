---
name: setup
description: One-click cookiedclaw setup — wires the current working directory as a self-contained agent workspace, downloads the gateway binary, writes systemd units, and gets the user one `systemctl start` away from a fully running daemon. Telegram bot token + identity files + Bearer-auth gateway + auto-restart. Runs from inside the workspace directory; idempotent on re-run.
disable-model-invocation: true
allowed-tools: Bash(mkdir -p *) Bash(chmod 600 *) Bash(chmod 700 *) Bash(test *) Bash(pwd) Bash(ls *) Bash(uname *) Bash(command -v *) Bash(loginctl enable-linger *) Bash(loginctl show-user *) Bash(systemctl --user daemon-reload) Bash(systemctl --user enable *) Bash(systemctl --user is-active *) Bash(systemctl --user is-enabled *) Bash(id -un) Bash(getent passwd *) Bash(ps -e -o *) Bash(awk *) Bash(wc -l) Bash(curl -fsSL *) Bash(curl -fsSLo *) Bash(sha256sum *) Bash(openssl rand *) Bash(grep -q *) Bash(echo *) Read Write Edit
---

# cookiedclaw onboarding wizard

You are walking the user through one-click cookiedclaw setup in the **current working directory**. End state:

- Workspace files (`CLAUDE.md`, `BOOTSTRAP.md`, `./.cookiedclaw/keys.env`) written.
- `TELEGRAM_BOT_TOKEN` + `COOKIEDCLAW_GATEWAY_TOKEN` saved to `keys.env`, chmod 600.
- Gateway binary downloaded from latest GitHub release, checksum-verified, in `~/.cookiedclaw/bin/`.
- Two `systemd --user` units (`cookiedclaw-gateway.service` + `cookiedclaw.service`) written and enabled.
- `loginctl enable-linger` confirmed.
- The user is one `systemctl --user start cookiedclaw-gateway cookiedclaw` away from a running daemon.

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

### 4c. Existing units from a different workspace

If `~/.config/systemd/user/cookiedclaw.service` or `~/.config/systemd/user/cookiedclaw-gateway.service` already exists, read them and check whether the workspace path baked in matches the current `pwd`. If they differ, **abort** with:

> Existing cookiedclaw units already point at a different workspace. The default unit names only hold one workspace at a time. To run multiple cookiedclaw daemons, use templated units (`cookiedclaw@<workspace>.service`) — that's a follow-up, not part of this wizard yet.

If they point at the current workspace, this is a re-run — proceed and overwrite.

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

### 4g. Launcher script (CC daemon side)

```bash
mkdir -p "$HOME/.cookiedclaw"

cat > "$HOME/.cookiedclaw/launcher.sh" <<EOF
#!/usr/bin/env bash
# cookiedclaw CC-daemon launcher — generated by /cookiedclaw:setup
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
# user-install bin dirs so claude (~/.local/bin) resolves.
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

If tmux is unavailable, swap the `tmux …` block for `script -qfc 'claude … --continue' /dev/null` (script(1) fallback).

### 4h. Two systemd units

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

The `Requires=` + `After=` make systemd start the gateway first and stop the CC daemon if the gateway dies — adapter is useless without gateway anyway.

### 4i. Reload + enable

```bash
systemctl --user daemon-reload
systemctl --user enable cookiedclaw-gateway cookiedclaw
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

Summarize what got configured (workspace path, files written, units enabled). Then send the switch-over instructions:

````
✓ Setup complete.

To start cookiedclaw:

  1. In the terminal running `claude` right now, press
     Ctrl+C twice to exit (it can't run alongside the daemon — Telegram
     only allows one bot poller at a time).

  2. From any terminal:

       systemctl --user start cookiedclaw-gateway cookiedclaw

     The gateway starts first; CC follows once it's up.

  3. DM your bot. Cookie should respond from inside the daemon.

After this:
  • Future restarts: /cookiedclaw:daemon-restart from Telegram
  • Daemon health: /cookiedclaw:daemon-status
  • Live-watch CC TUI: tmux attach -t cookiedclaw
  • Live logs:
      journalctl --user -fu cookiedclaw-gateway
      journalctl --user -fu cookiedclaw

Roll back:
  systemctl --user disable --now cookiedclaw cookiedclaw-gateway
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
