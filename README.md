<p align="center">
  <img src="assets/banner.jpg" alt="cookiedclaw — your personal AI agent on Telegram" width="900" />
</p>

<p align="center">
  <a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/runtime-bun-fbf0df?logo=bun&logoColor=000" /></a>
  <a href="https://code.claude.com"><img alt="Claude Code" src="https://img.shields.io/badge/plugin-claude%20code-d97757" /></a>
  <a href="https://core.telegram.org/bots/api"><img alt="Telegram Bot API" src="https://img.shields.io/badge/telegram-bot%20api-26a5e4?logo=telegram&logoColor=fff" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/protocol-MCP-7c3aed" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-22c55e" /></a>
</p>

<p align="center">
  <b>Text your bot from anywhere. Claude Code does the work on your machine. The reply lands back in chat.</b>
</p>

---

> [!WARNING]
> **Architecture in flux.** This adapter just split apart from its all-in-one form. The TypeScript runtime moved out into [`cookiedclaw/cookiedclaw`](https://github.com/cookiedclaw/cookiedclaw) (the universal gateway), and this repo is becoming a config-only Claude Code adapter that connects to that gateway via HTTP MCP. **The migration isn't user-ready yet** — gateway distribution (compiled binary, systemd unit, install wizard) is still being put together. Until that lands, run the previous all-in-one version (any tag ≤ `v0.4.0`) instead of `main`.

## Overview

**cookiedclaw** turns any Telegram chat into a frontend for your Claude Code session. Inbound DMs become `<channel source="cookiedclaw">` events the agent can act on; CC's tool calls, permission prompts, and file output flow back to the chat in real time.

The Claude Code-specific piece is small (config + hooks + skills); the heavy lifting — Telegram polling, paired-user state, persistence, MCP server — lives in the [universal gateway](https://github.com/cookiedclaw/cookiedclaw). This adapter is what wires CC into that gateway.

> [!IMPORTANT]
> **Your Max subscription is billed as a subscription.** Because cookiedclaw runs inside Claude Code (not via the Anthropic SDK), Max-included usage applies normally — no surprise extra-API charges that SDK-based Telegram bridges incur. If you already pay for Claude Max, cookiedclaw is effectively free to run.

> [!NOTE]
> Marketplace install path isn't open yet — for now you load this as a development channel (one extra CLI flag). Will go away once the plugin is approved.

## Features

- **Live tool progress** — a single message edits in place as CC runs tools (`⏳ Bash: ls -la` → `✓ Bash: ls -la (45ms)`). Tool activity that fires *after* the visible reply (sub-agents wrapping up, post-task edits to identity files) keeps streaming into the same progress message until your next message — that's the bot finishing up, not stuck.
- **Permission relay** — CC's tool-approval prompts (Bash, Write, Edit, …) come through Telegram as `[✓ Allow]` / `[✗ Deny]` inline buttons. The local terminal dialog stays open in parallel — first answer wins.
- **MarkdownV2 replies** — CommonMark in, properly-escaped Telegram out via `telegramify-markdown`. Code blocks, links, lists, the works.
- **Image & file dispatch, both directions** — outbound via `[embed:path]` (auto-detects → photo, single-embed-with-caption fast path) or `[file:path]` (always a document). Inbound photos and documents are downloaded and surfaced to the agent so it can `Read` them with full vision support.
- **Pairing flow** — first contact gets a 5-letter code; the owner approves with `pair <code>`. Persistent allowlist in `~/.cookiedclaw/access.json`, with `revoke_access` and `list_access` to manage it.
- **Bot menu auto-population** — the Telegram slash-command menu mirrors every skill installed in CC (user-level + project-level + every enabled plugin), with payload-cap backoff for the undocumented `BOT_COMMANDS_TOO_MUCH` ceiling.
- **`/stop`** — drops the progress message and signals the agent to abort the in-flight work, immediately.
- **Sender attribution** — every inbound message is prefixed `[Tymur Turatbekov (@wowtist247)]: …` so the agent knows who's talking in shared / family chats.
- **Persistent identity** — first-contact wizard writes `IDENTITY.md`, `USER.md`, and a `SOUL.md` (per the [soul.md spec](https://soul.md/)) into `~/.cookiedclaw/`; the agent reads them at every session start.

## Quickstart

> [!IMPORTANT]
> Prerequisites: [Bun](https://bun.sh), [Claude Code](https://code.claude.com) v2.1.80+ logged in with a **claude.ai** account (Console / API-key auth doesn't support channels), and a Telegram account.

Install the plugin from this repo's custom marketplace:

```bash
claude plugin marketplace add cookiedclaw/cookiedclaw-claude-code
claude plugin install cookiedclaw@cookiedclaw-claude-code
```

Then create a **workspace** for your agent — a directory that becomes its home (identity, paired users, downloaded attachments all live there). Each workspace = one independent agent, so you can have a personal one and a work one side by side.

```bash
mkdir -p ~/cookiedclaw && cd ~/cookiedclaw
claude --enable-auto-mode --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw-claude-code
```

Inside that CC session, run the onboarding wizard:

```
/cookiedclaw:setup
```

> [!TIP]
> **`--enable-auto-mode` is strongly recommended for cookiedclaw.** Without it, CC interrupts to ask "are you sure?" before non-trivial tool calls — fine in your terminal, painful when you're driving the agent from Telegram. With auto-mode the agent makes reasonable judgement calls and only pauses for genuinely risky operations (which still hit the permission relay → inline `[✓ Allow] [✗ Deny]` buttons in chat). Most cookiedclaw users want this on by default.

It walks you through:

1. Creating a Telegram bot with [@BotFather](https://t.me/BotFather) and saving the token to `./.cookiedclaw/keys.env`.
2. Optional integrations — fal.ai (image / video generation) and [Supermemory](https://supermemory.ai) (cross-session memory).
3. A first-contact identity discovery: you tell the agent who you are and what to call it; it writes `IDENTITY.md` / `USER.md` / `SOUL.md` into the workspace root.
4. A workspace `CLAUDE.md` — the agent's system prompt, auto-loaded by CC every time you launch from this directory.

Restart CC from the same workspace directory, DM your bot, and pair yourself with the code the bot replies with. From then on, you're talking to your CC session over Telegram.

> [!NOTE]
> The `--dangerously-load-development-channels` flag is required because cookiedclaw isn't on Anthropic's curated channel allowlist yet. It'll go away once the plugin is approved.

<details>
<summary>Developer setup (cloning the repo)</summary>

If you're hacking on cookiedclaw itself:

```bash
git clone git@github.com:cookiedclaw/cookiedclaw-claude-code.git
cd cookiedclaw-claude-code
bun install

# Run from a separate workspace directory so identity files don't land in the repo
mkdir -p ~/cookied-dev && cd ~/cookied-dev
claude --enable-auto-mode \
       --plugin-dir ~/projects/bots/cookiedclaw-claude-code \
       --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw-claude-code
```

`.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}` so CC must load the cloned dir as a plugin (`--plugin-dir`). Workspace state (keys, identity, access list) lives in whatever dir you run `claude` from — keep that separate from the source repo.

</details>

## How it works

```
Telegram ─DM─►  cookiedclaw gateway  ──MCP-over-HTTP──►  Claude Code
                (separate bun process,                   (this adapter:
                 see /cookiedclaw/cookiedclaw)             .mcp.json points
                       ▲                                   at gateway URL,
                       │                                   hooks fire on
                       │ ◄── reply / react / pair / …  ◄── tool use)
                       │     (gateway tools, called by
                       │      CC via the HTTP MCP server)
                       │
                  Pre/PostToolUse hooks (hooks/tool-progress.ts)
                       │  POST localhost progress endpoint (gateway-hosted)
                       ▼
                  edit live progress message in chat
```

This adapter is config-only. The TypeScript runtime, Telegram polling, paired-user state, and the MCP server itself all live in the [gateway](https://github.com/cookiedclaw/cookiedclaw). What stays here:

| Path | Concern |
|------|---------|
| `.mcp.json` | Points CC at the gateway's HTTP MCP endpoint (Bearer-authed). |
| `hooks/tool-progress.ts` | Pre/PostToolUse/Stop hook — POSTs tool events to the gateway's progress endpoint so the live progress message updates. Stand-alone bun script, no npm deps. |
| `skills/setup/SKILL.md` | `/cookiedclaw:setup` — first-run wizard (writes identity files + keys.env). |
| `skills/{enable,daemon-status,daemon-restart,install-skill}/SKILL.md` | Daemon-mode lifecycle skills. |
| `skills/{fal,supermemory}-setup/SKILL.md` | Optional integration installers. |
| `CLAUDE.md` / identity files | Agent system prompt + persona, auto-loaded by CC. |

## Workspace layout

Everything cookiedclaw needs lives in your workspace directory — the one you ran `/cookiedclaw:setup` from. Multiple workspaces = multiple independent agents.

```
~/cookiedclaw/                  ← your workspace
├── CLAUDE.md                   ← system prompt (CC auto-loads from CWD)
├── BOOTSTRAP.md                ← first-contact discovery (self-deletes)
├── IDENTITY.md                 ← agent's name, nature, vibe
├── USER.md                     ← who you are
├── SOUL.md                     ← agent's values & continuity essay
└── .cookiedclaw/               ← hidden state
    ├── keys.env                ← bot token + integration keys (chmod 600)
    ├── access.json             ← paired Telegram users
    ├── inbox/                  ← downloaded attachments
    └── cache/
        ├── progress.log        ← shared diagnostic log
        └── progress.port       ← localhost port for tool-progress hooks
```

The setup wizard creates and maintains `keys.env` and `access.json`; you rarely edit them by hand. Identity files (`IDENTITY.md`, `USER.md`, `SOUL.md`) are agent-written and human-editable — tweak any time.

> [!TIP]
> Diagnostics live in `./.cookiedclaw/cache/progress.log` (within your workspace). If something doesn't reach Telegram, that log usually shows where the chain broke (server didn't bind, hook couldn't find the port, no active chat, etc.).

## Running on a server

Once configured, you usually want cookiedclaw running 24/7 — not tied to your laptop. The simplest path is `tmux`: a session that keeps CC alive after you disconnect from SSH.

```bash
ssh -L 8080:localhost:8080 user@your-server   # one-time, port-forward for the OAuth flow
claude /login                                  # browser auth — happens once
claude plugin marketplace add cookiedclaw/cookiedclaw-claude-code
claude plugin install cookiedclaw@cookiedclaw-claude-code
mkdir -p ~/cookiedclaw && cd ~/cookiedclaw    # workspace dir
tmux new -s cookied
claude --enable-auto-mode --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw-claude-code
# Run /cookiedclaw:setup inside CC the first time
# Ctrl+b d  to detach — session keeps running, you can exit SSH
```

To come back later:

```bash
ssh user@your-server
tmux attach -t cookied
```

> [!NOTE]
> A server reboot kills the tmux session — you'll need to `tmux new` and start CC again. If you want auto-start-on-boot and auto-restart-on-crash, wrap this in a systemd `--user` unit.

## Going daemon

`/cookiedclaw:setup` is the one-shot wizard that handles **everything**: workspace files, Telegram bot token, GATEWAY_TOKEN generation, gateway binary download (from latest GitHub release), checksum verification, two `systemd --user` units (gateway + CC daemon), linger, and how to start it. Linux only for the daemon part — macOS / BSD users get a tmux fallback.

After setup:

- **`/cookiedclaw:daemon-restart`** — Cookie restarts the whole CC session via systemd, no terminal access needed. Useful after installing a new MCP / plugin / skill that's only discovered at startup.
- **`/cookiedclaw:daemon-status`** — quick health check (active / enabled / pid / last restart / journal tail). Use before assuming the daemon is healthy.
- **`/cookiedclaw:install-skill <package>`** — installs a skill via [skills.sh](https://skills.sh) and restarts cookiedclaw automatically so it's immediately available.
- Live debug: `tmux attach -t cookiedclaw`. Logs: `journalctl --user -fu cookiedclaw cookiedclaw-gateway`. Roll back: `systemctl --user disable --now cookiedclaw cookiedclaw-gateway`.

> [!WARNING]
> `/cookiedclaw:install-skill` runs `npx skills add <pkg>` under the hood, which executes arbitrary code from third-party repos. The agent picks high-install-count packages from trusted sources (`vercel-labs`, `anthropics`, `obra`, …) but there's no signature check. Treat unfamiliar package names with the same caution you'd apply to `curl | bash`.

This stays a Claude Code plugin — the agent still runs *inside* a real CC session. The systemd wrapper is just keep-alive + remote-restart plumbing around it.

Multi-workspace daemons (one per workspace) need a templated unit (`cookiedclaw@<name>.service` with `WorkingDirectory=%i`). That's a follow-up; today the wizard handles a single workspace and explicitly refuses to overwrite an existing one from elsewhere.

## Roadmap

- **Marketplace publish** so the dev flag goes away and install becomes one line of `/plugin install`.
- **Multi-bot** — one cookiedclaw, multiple Telegram bots routed through the same CC session, each with isolated context (so a family / team can each have their own bot personality).
- **More integrations** in the setup wizard — Notion, GitHub, calendar — based on what people actually want.

## Acknowledgements

cookiedclaw stands on the shoulders of [Claude Code](https://code.claude.com), [grammy](https://grammy.dev), the [Model Context Protocol](https://modelcontextprotocol.io), [telegramify-markdown](https://github.com/skoropadas/telegramify-markdown), and [gray-matter](https://github.com/jonschlinkert/gray-matter). The `BOOTSTRAP.md` / `IDENTITY.md` / `USER.md` / `SOUL.md` workspace convention is borrowed from [OpenClaw](https://github.com/steipete/openclaw).
