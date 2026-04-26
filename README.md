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

## Overview

**cookiedclaw** is a Claude Code plugin that turns any Telegram chat into a frontend for your CC session. It bridges Telegram and CC over a custom MCP channel so inbound DMs become `<channel source="telegram">` events the agent can act on, and CC's tool calls, permission prompts, and file output flow back to the chat in real time.

It's small enough to read in an afternoon (~2k LOC of TypeScript across 14 focused modules) and pragmatic about the trade-offs: the agent runs on your hardware and keeps a persistent identity across sessions in `~/.cookiedclaw/`.

> [!IMPORTANT]
> **Your Max subscription is billed as a subscription.** Because cookiedclaw runs inside Claude Code (not via the Anthropic SDK), Max-included usage applies normally — no surprise extra-API charges that SDK-based Telegram bridges incur. If you already pay for Claude Max, cookiedclaw is effectively free to run.

> [!NOTE]
> cookiedclaw is in active development. The marketplace install path isn't open yet — for now you load it as a development channel (one extra CLI flag).

## Features

- **Live tool progress** — a single message edits in place as CC runs tools (`⏳ Bash: ls -la` → `✓ Bash: ls -la (45ms)`). Pre/PostToolUse hooks → localhost endpoint → `editMessage`. Broadcasts to every chat that's mid-turn so multi-user conversations don't lose their feed.
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
claude plugin marketplace add cookiedclaw/cookiedclaw
claude plugin install cookiedclaw@cookiedclaw
```

Then create a **workspace** for your agent — a directory that becomes its home (identity, paired users, downloaded attachments all live there). Each workspace = one independent agent, so you can have a personal one and a work one side by side.

```bash
mkdir -p ~/cookiedclaw && cd ~/cookiedclaw
claude --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw
```

Inside that CC session, run the onboarding wizard:

```
/cookiedclaw:setup
```

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
git clone git@github.com:cookiedclaw/cookiedclaw.git
cd cookiedclaw
bun install

# Run from a separate workspace directory so identity files don't land in the repo
mkdir -p ~/cookied-dev && cd ~/cookied-dev
claude --plugin-dir ~/projects/bots/cookiedclaw \
       --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw
```

`.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}` so CC must load the cloned dir as a plugin (`--plugin-dir`). Workspace state (keys, identity, access list) lives in whatever dir you run `claude` from — keep that separate from the source repo.

</details>

## How it works

```
Telegram ─DM─►  src/telegram-channel.ts  ─MCP notifications/claude/channel─►  Claude Code
                (bun process, MCP server)                                          │
                       ▲                                                           │
                       │ ◄── reply / react / pair / revoke_access / list_access ◄──┘
                       │
                  Pre/PostToolUse hooks (hooks/tool-progress.ts)
                       │  POST localhost:port
                       ▼
                  edit live progress message in chat
```

Each box is a single-purpose module:

| Module | Concern |
|--------|---------|
| `src/telegram-channel.ts` | Wiring entrypoint — imports the rest |
| `src/{paths,env,bot}.ts` | Filesystem layout, env loading, grammy bot singleton |
| `src/{format,chat-state,access}.ts` | MarkdownV2, per-chat state, pair codes / allowlist |
| `src/{attachments,progress}.ts` | Embed markers, file download, tool-progress rendering |
| `src/{mcp,tools}.ts` | MCP server + the five tools (`reply`, `react`, `pair`, `revoke_access`, `list_access`) |
| `src/{inbound,permission-relay}.ts` | grammy handlers for text / photo / document, permission-prompt buttons |
| `src/{progress-server,skill-discovery}.ts` | Localhost endpoint for hooks, slash-menu population |
| `hooks/tool-progress.ts` | Pre/PostToolUse hook script |
| `skills/setup/SKILL.md` | The `/cookiedclaw:setup` wizard |

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
claude plugin marketplace add cookiedclaw/cookiedclaw
claude plugin install cookiedclaw@cookiedclaw
mkdir -p ~/cookiedclaw && cd ~/cookiedclaw    # workspace dir
tmux new -s cookied
claude --dangerously-load-development-channels plugin:cookiedclaw@cookiedclaw
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

## Roadmap

- **Marketplace publish** so the dev flag goes away and install becomes one line of `/plugin install`.
- **Multi-bot** — one cookiedclaw, multiple Telegram bots routed through the same CC session, each with isolated context (so a family / team can each have their own bot personality).
- **More integrations** in the setup wizard — Notion, GitHub, calendar — based on what people actually want.

## Acknowledgements

cookiedclaw stands on the shoulders of [Claude Code](https://code.claude.com), [grammy](https://grammy.dev), the [Model Context Protocol](https://modelcontextprotocol.io), [telegramify-markdown](https://github.com/skoropadas/telegramify-markdown), and [gray-matter](https://github.com/jonschlinkert/gray-matter). The `BOOTSTRAP.md` / `IDENTITY.md` / `USER.md` / `SOUL.md` workspace convention is borrowed from [OpenClaw](https://github.com/steipete/openclaw).
