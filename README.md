<p align="center">
  <img src="assets/banner.jpg" alt="cookiedclaw — your personal AI agent on Telegram" width="900" />
</p>

<p align="center">
  <a href="https://code.claude.com"><img alt="Claude Code" src="https://img.shields.io/badge/plugin-claude%20code-d97757" /></a>
  <a href="https://core.telegram.org/bots/api"><img alt="Telegram Bot API" src="https://img.shields.io/badge/telegram-bot%20api-26a5e4?logo=telegram&logoColor=fff" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/protocol-MCP-7c3aed" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-22c55e" /></a>
</p>

<p align="center">
  <b>Text your bot from anywhere. Claude Code does the work on your machine. The reply lands back in chat.</b>
</p>

---

## Install

Two steps: gateway binary, then the CC plugin + workspace.

```bash
# 1. Gateway binary (~64 MB, sha256-verified, lands in ~/.cookiedclaw/bin/)
curl -fsSL https://cookiedclaw.com/install.sh | bash

# 2. Plugin
claude plugin marketplace add cookiedclaw/cookiedclaw-claude-code
claude plugin install cookiedclaw@cookiedclaw-claude-code

# 3. Workspace
mkdir -p ~/cookiedclaw && cd ~/cookiedclaw
claude --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw-claude-code
```

Inside that CC session:

```
/cookiedclaw:setup
```

The wizard handles the per-workspace bits — BotFather token, identity files (`IDENTITY.md`, `USER.md`, `SOUL.md`), `COOKIEDCLAW_GATEWAY_TOKEN`, `systemd --user` unit, linger. When it's done:

```bash
^C                                                # exit ad-hoc claude
systemctl --user start cookiedclaw-gateway        # start the daemon
```

DM your bot. Cookie answers.

> Linux only for the daemon part. macOS / BSD users get a tmux fallback (no auto-restart).

### Upgrading the gateway

```bash
cookiedclaw-gateway update      # or rerun curl -fsSL .../install.sh | bash — same effect
```

Fetches the latest release, sha256-verifies, atomic-swaps, restarts the systemd unit if it's active.

## What you get

- **Live tool progress** — one message edits in place as CC runs tools (`⏳ Bash: ls -la` → `✓ Bash: ls -la (45ms)`).
- **Permission relay** — CC's tool prompts come through Telegram as `[✓ Allow]` / `[✗ Deny]` inline buttons.
- **Image & file dispatch, both ways** — outbound via `[embed:path]` / `[file:path]`; inbound photos and documents downloaded so the agent can `Read` them with full vision support.
- **Pairing flow** — first contact gets a 5-letter code; the owner approves with `pair <code>`. Allowlist persists in `~/.cookiedclaw/access.json`.
- **`/stop`** — drops the progress message and signals the agent to abort the in-flight work immediately.
- **Persistent identity** — first-run wizard writes `IDENTITY.md`, `USER.md`, `SOUL.md` (per the [soul.md spec](https://soul.md/)) into the workspace; the agent reads them at every session start.

## Skills you get from setup

| Skill | What it does |
|-------|--------------|
| `/cookiedclaw:setup` | One-shot installer (this is the one above) |
| `/cookiedclaw:daemon-status` | Quick health check — active / pid / last restart / journal tail |
| `/cookiedclaw:daemon-restart` | Restart the CC session via systemd, no terminal needed |
| `/cookiedclaw:install-skill <pkg>` | Install a skill from [skills.sh](https://skills.sh) and auto-restart |
| `/cookiedclaw:fal-setup` | Image / video generation via fal.ai |
| `/cookiedclaw:supermemory-setup` | Cross-session semantic memory (Supermemory Pro) |

## How it fits together

```
Telegram ◄─poll─► cookiedclaw gateway      <- always-on, systemd-managed
                  (single binary, see          owns Telegram bot, paired
                   /cookiedclaw/cookiedclaw)   users, MCP-over-HTTP server
                       ▲
                       │ MCP-over-HTTP (localhost, Bearer auth)
                       │
                  Claude Code + this plugin   <- runs your work, hooks
                  (.mcp.json points here,        push tool-progress to
                   hooks fire on tool use)       gateway endpoint
```

One `systemd --user` unit: `cookiedclaw-gateway.service`. The gateway supervises its own child Claude Code process (via `~/.cookiedclaw/launcher.sh`) — there's no separate daemon unit.

> Your Max subscription is billed as a subscription. Because cookiedclaw runs inside Claude Code (not via the Anthropic SDK), Max-included usage applies normally — no surprise extra-API charges. If you already pay for Claude Max, cookiedclaw is effectively free to run.

## Workspace layout

Each workspace = one independent agent. Multiple agents = multiple workspace dirs.

```
~/cookiedclaw/                  ← your workspace
├── CLAUDE.md                   ← system prompt (CC auto-loads from CWD)
├── IDENTITY.md / USER.md / SOUL.md
└── .cookiedclaw/
    ├── keys.env                ← bot token + GATEWAY_TOKEN (chmod 600)
    ├── access.json             ← paired Telegram users
    └── inbox/                  ← downloaded attachments

~/.cookiedclaw/
├── bin/cookiedclaw-gateway     ← gateway binary (installed by install.sh, updated by `cookiedclaw-gateway update`)
└── launcher.sh                 ← CC daemon entrypoint (written by /cookiedclaw:setup)
```

## Roll back

```bash
systemctl --user disable --now cookiedclaw-gateway
rm -rf ~/.cookiedclaw
claude plugin uninstall cookiedclaw@cookiedclaw-claude-code
```

## Related

- **[cookiedclaw/cookiedclaw](https://github.com/cookiedclaw/cookiedclaw)** — the universal gateway (binary you just installed)
- **[cookiedclaw/cookiedclaw-cursor](https://github.com/cookiedclaw/cookiedclaw-cursor)** — sibling Cursor IDE adapter (same gateway, different runtime)
- **[landing](https://cookiedclaw.com)** — pitch page
- **[org profile](https://github.com/cookiedclaw)** — family of `cookiedclaw-*` adapters

> [!NOTE]
> Marketplace install path isn't on Anthropic's curated channel allowlist yet — `--dangerously-load-development-channels` is required for now. Goes away once the plugin is approved.
