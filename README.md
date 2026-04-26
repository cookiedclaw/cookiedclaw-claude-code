# cookiedclaw

A Claude Code plugin that brings Telegram into your CC session: text your bot from anywhere, CC does the work using your claude.ai subscription, the reply lands back in the chat.

> **Status:** early POC. Right now it's just a custom channel — `--dangerously-load-development-channels` is required because we're not on the Anthropic-curated allowlist yet. Multi-bot, hooks for tool progress, onboarding wizard, and image/file dispatch are planned next.

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Claude Code](https://code.claude.com) v2.1.80+, logged in with a claude.ai account (Console / API key auth doesn't support channels)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram user ID (DM [@userinfobot](https://t.me/userinfobot))

## Setup

```bash
bun install
```

Set the env in your shell (or a `.env` file in this directory — Bun loads it automatically):

```sh
TELEGRAM_BOT_TOKEN=123456:abc...
TELEGRAM_ALLOWED_USERS=12345678,87654321   # your Telegram user ID(s), comma-separated
```

Anyone not in `TELEGRAM_ALLOWED_USERS` gets dropped silently — without that allowlist, your bot becomes a prompt-injection vector.

## Run

From this directory:

```bash
claude --dangerously-load-development-channels server:telegram
```

CC starts, reads `.mcp.json`, spawns `src/telegram-channel.ts` over stdio, and the bot starts long-polling Telegram.

DM your bot. The message arrives in your CC terminal as a `<channel source="telegram" chat_id="..." sender="...">` event. CC works on it, calls the `reply` tool, and the response shows up in Telegram.

## What's missing (next steps)

- **Pairing flow** instead of manual env-var allowlist
- **PreToolUse / PostToolUse hooks** that edit a Telegram progress message live, so you can watch CC work in the chat instead of seeing nothing until the final reply
- **Onboarding skill** (`/cookiedclaw:setup`) to walk through fal.ai / Supermemory / Tavily key setup and wire up the matching MCP servers
- **Multi-bot** for family members, each with their own background sub-agent and own context
- **Image / file dispatch** with `[embed:path]` / `[file:path]` markers, ported from the previous standalone iteration
