<p align="center">
  <img src="assets/banner.jpg" alt="cookiedclaw — your personal AI agent on Telegram" />
</p>

# cookiedclaw

A Claude Code plugin that turns any Telegram chat into a frontend for your CC session. DM your bot from anywhere, the agent runs on your machine using your claude.ai subscription, the reply lands back in chat. Tool progress streams live, image and file attachments work both ways, and the agent has a persistent identity that survives between sessions.

## Quick start

```bash
git clone git@github.com:cookiedclaw/cookiedclaw.git
cd cookiedclaw
bun install
claude --dangerously-load-development-channels server:telegram
```

Inside the CC session, run `/cookiedclaw:setup`. The wizard walks you through:

- Creating a Telegram bot via [@BotFather](https://t.me/BotFather), saving the token to `~/.cookiedclaw/keys.env`
- Optional integrations (fal.ai for image generation, Supermemory for cross-session memory)
- A first-contact identity discovery (you tell the agent who you are and what to call it; it writes IDENTITY/USER/SOUL.md to `~/.cookiedclaw/`)

After setup, restart CC. DM the bot — the first time anyone reaches out unrecognised, they get a 5-letter pair code. Tell the agent `pair <code>` to add them to the allowlist.

> The `--dangerously-load-development-channels server:telegram` flag is required because cookiedclaw isn't on Anthropic's curated channel allowlist yet. It will go away once the plugin lands on the marketplace.

## What it does

- **Telegram ⇄ Claude Code bridge** via a custom MCP channel server. Inbound DMs become `<channel source="telegram" sender="...">` events; the agent replies through a `reply` tool that also accepts `[embed:path]` / `[file:path]` markers for attachments.
- **Live tool progress** in the chat — a single message edits in place (`⏳ Bash: ls -la` → `✓ Bash: ls -la (45ms)`) via Pre/PostToolUse hooks → localhost endpoint → editMessage. Broadcasts to every chat that's mid-turn, so multi-user conversations don't lose progress.
- **MarkdownV2 rendering** for replies (CommonMark in, properly-escaped Telegram out via `telegramify-markdown`).
- **Permission relay with inline buttons.** Tool-approval prompts (Bash, Write, Edit) come through Telegram with `[✓ Allow]` / `[✗ Deny]`; the local terminal dialog stays open in parallel — first answer wins.
- **Pairing flow** with persistent allowlist (`~/.cookiedclaw/access.json`). Plus `pair`, `revoke_access`, `list_access` MCP tools for the owner. `TELEGRAM_ALLOWED_USERS` env still works as a static bypass.
- **Image / file dispatch, both directions.** Outbound via `[embed:path]` (auto-detect → photo, single-embed-with-caption fast path) and `[file:path]` (always document); inbound photos and documents download to `~/.cache/cookiedclaw/inbox/` and surface the path to the agent so it can `Read` them (vision-aware for images).
- **Reactions** via the `react` tool — short ack-style messages get an emoji instead of a generated reply.
- **`/stop`** as a built-in slash command — kills typing, drops the progress message immediately, and signals the agent to abort whatever it's doing.
- **Bot menu** auto-populated from CC's discovered skills (user-level + project-level + every enabled plugin via `claude plugin list --json`); names normalized to Telegram's `[a-z0-9_]{1,32}`, payload-cap backoff for the undocumented `BOT_COMMANDS_TOO_MUCH` ceiling.
- **Sender attribution** on every inbound — `[Tymur Turatbekov (@wowtist247)]: hi` — so the agent reliably knows who's talking in multi-user chats.
- **Persistent identity** via OpenClaw's 4-file convention in `~/.cookiedclaw/`: `BOOTSTRAP.md` (one-shot first-contact script), `IDENTITY.md` (who the agent is), `USER.md` (who you are), `SOUL.md` (the agent's continuity-of-self essay, per [soul.md](https://soul.md/)).

## How it works

```
Telegram ─DM─►  src/telegram-channel.ts  ─MCP notifications/claude/channel─►  Claude Code
                (bun process, MCP server)                                          │
                       ▲                                                           │
                       │ ◄─ reply / react / pair / revoke_access / list_access  ◄──┘
                       │
                  Pre/PostToolUse hooks (hooks/tool-progress.ts)
                       │  POST localhost:port
                       ▼
                  edit live progress message in chat
```

Repo layout:

- `src/telegram-channel.ts` — wiring entry point. Imports the rest as modules / side effects.
- `src/{paths,env,bot,format,chat-state,access,attachments,progress,mcp,tools,inbound,permission-relay,progress-server,skill-discovery}.ts` — one concern per file (~30–260 lines each).
- `hooks/tool-progress.ts` — the Pre/PostToolUse hook that POSTs to the channel server's localhost endpoint.
- `skills/setup/SKILL.md` — the `/cookiedclaw:setup` wizard.
- `.claude-plugin/plugin.json` + `hooks/hooks.json` — kept for the eventual marketplace publish.
- `.mcp.json` + `.claude/settings.json` — what CC actually reads in development mode.
- `CLAUDE.md` — auto-loaded by CC at startup; tells the agent to read the `~/.cookiedclaw/` workspace files.

## Configuration

`~/.cookiedclaw/` is the per-user workspace. The setup wizard creates and maintains it; you rarely edit by hand.

| Path | What it is |
|------|------------|
| `keys.env` | `TELEGRAM_BOT_TOKEN`, optional `FAL_KEY`, `SUPERMEMORY_CC_API_KEY`. `chmod 600`. Read by the channel server at startup. |
| `access.json` | Paired Telegram users. Edit only via `pair` / `revoke_access` / `list_access` MCP tools. |
| `IDENTITY.md` | The agent's name, nature, vibe — written by the agent during first-contact. |
| `USER.md` | Your name, timezone, language, tone preferences. |
| `SOUL.md` | The agent's values and boundaries, narrative essay. The continuity-of-self file. |

Diagnostics live in `~/.cache/cookiedclaw/progress.log` — channel server and hook script both write here. If something doesn't reach Telegram, that log usually shows where the chain broke.

## Why `--dangerously-load-development-channels` and not `--plugin-dir .`?

If you load this repo as both a project (via `.mcp.json`) and a plugin (via `--plugin-dir .`), CC registers the same MCP server twice. The `--dangerously-load-development-channels` flag opts in *one* of them as a channel — the other becomes a plain MCP server with no inbound message routing. Use the project path for development; the plugin path is for the eventual marketplace install.

## Roadmap

- **Marketplace publish** so the dev flag goes away and install becomes one line of `/plugin install`
- **Multi-bot** — one cookiedclaw, multiple Telegram bots routed through the same CC session, each with isolated context (so a family / team can each have their own bot personality)
- **More integrations** in the setup wizard — Notion, GitHub, calendar — based on what people actually want

## License

MIT
