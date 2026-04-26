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

It's small enough to read in an afternoon (~2k LOC of TypeScript across 14 focused modules) and pragmatic about the trade-offs: the agent uses your existing claude.ai subscription, runs on your hardware, and keeps a persistent identity across sessions in `~/.cookiedclaw/`.

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

```bash
git clone git@github.com:cookiedclaw/cookiedclaw.git
cd cookiedclaw
bun install
claude --dangerously-load-development-channels server:telegram
```

Inside the CC session, run the onboarding wizard:

```
/cookiedclaw:setup
```

It walks you through:

1. Creating a Telegram bot with [@BotFather](https://t.me/BotFather) and saving the token to `~/.cookiedclaw/keys.env`.
2. Optional integrations — fal.ai (image / video generation) and [Supermemory](https://supermemory.ai) (cross-session memory).
3. A first-contact identity discovery: you tell the agent who you are and what to call it; it writes `IDENTITY.md` / `USER.md` / `SOUL.md` into `~/.cookiedclaw/`.

Restart CC, DM your bot, and pair yourself with a code the bot replies with. From then on, you're talking to your CC session over Telegram.

> [!WARNING]
> Don't pass `--plugin-dir .` for development. CC will register the same MCP server twice (once as project, once as plugin) and only one of them will be opted in as a channel — you'll end up with a working `reply` tool but no inbound message routing. The plugin manifest stays in the repo for the eventual marketplace publish.

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

## Configuration

Per-user state lives in `~/.cookiedclaw/`. The setup wizard creates and maintains it; you rarely edit by hand.

| Path | What it is |
|------|------------|
| `keys.env` | `TELEGRAM_BOT_TOKEN`, optional `FAL_KEY`, `SUPERMEMORY_CC_API_KEY`. `chmod 600`. |
| `access.json` | Paired Telegram users. Edit only via the `pair` / `revoke_access` / `list_access` MCP tools. |
| `BOOTSTRAP.md` | One-shot first-contact script. Self-deletes after the agent runs it. |
| `IDENTITY.md` | The agent's name, nature, vibe. Written by the agent during first contact, edited freely thereafter. |
| `USER.md` | Your name, timezone, language, tone preferences. |
| `SOUL.md` | The agent's continuity-of-self essay, per [soul.md](https://soul.md/). |

> [!TIP]
> Diagnostics live in `~/.cache/cookiedclaw/progress.log` — channel server and hook script both write here. If something doesn't reach Telegram, that log usually shows where the chain broke (server didn't bind, hook couldn't find the port, no active chat, etc.).

## Roadmap

- **Marketplace publish** so the dev flag goes away and install becomes one line of `/plugin install`.
- **Multi-bot** — one cookiedclaw, multiple Telegram bots routed through the same CC session, each with isolated context (so a family / team can each have their own bot personality).
- **More integrations** in the setup wizard — Notion, GitHub, calendar — based on what people actually want.

## Acknowledgements

cookiedclaw stands on the shoulders of [Claude Code](https://code.claude.com), [grammy](https://grammy.dev), the [Model Context Protocol](https://modelcontextprotocol.io), [telegramify-markdown](https://github.com/skoropadas/telegramify-markdown), and [gray-matter](https://github.com/jonschlinkert/gray-matter). The `BOOTSTRAP.md` / `IDENTITY.md` / `USER.md` / `SOUL.md` workspace convention is borrowed from [OpenClaw](https://github.com/steipete/openclaw).
