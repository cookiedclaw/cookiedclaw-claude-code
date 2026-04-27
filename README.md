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

```bash
claude plugin marketplace add cookiedclaw/cookiedclaw-claude-code
claude plugin install cookiedclaw@cookiedclaw-claude-code

mkdir -p ~/cookiedclaw && cd ~/cookiedclaw
claude --enable-auto-mode --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw-claude-code
```

Inside that CC session:

```
/cookiedclaw:setup
```

That single wizard does **everything** — BotFather token, identity files, downloads the [gateway](https://github.com/cookiedclaw/cookiedclaw) binary from latest release, generates an MCP Bearer token, writes two `systemd --user` units, enables linger. When it's done:

```bash
^C                                                       # exit ad-hoc claude
systemctl --user start cookiedclaw-gateway cookiedclaw   # start the daemon
```

DM your bot. Cookie answers.

> Linux only for the daemon part. macOS / BSD users get a tmux fallback (no auto-restart).

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

Two `systemd --user` units: `cookiedclaw-gateway.service` (the binary) and `cookiedclaw.service` (CC daemon, depends on the gateway).

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
├── bin/cookiedclaw-gateway     ← gateway binary, downloaded by setup
└── launcher.sh                 ← CC daemon entrypoint
```

## Roll back

```bash
systemctl --user disable --now cookiedclaw cookiedclaw-gateway
rm -rf ~/.cookiedclaw/bin
claude plugin uninstall cookiedclaw@cookiedclaw-claude-code
```

## Related

- **[cookiedclaw/cookiedclaw](https://github.com/cookiedclaw/cookiedclaw)** — the universal gateway (binary you just installed)
- **[landing](https://landing-blush-xi-11.vercel.app)** — pitch page
- **[org profile](https://github.com/cookiedclaw)** — family of `cookiedclaw-*` adapters

> [!NOTE]
> Marketplace install path isn't on Anthropic's curated channel allowlist yet — `--dangerously-load-development-channels` is required for now. Goes away once the plugin is approved.
