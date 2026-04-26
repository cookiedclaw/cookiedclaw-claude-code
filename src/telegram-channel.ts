#!/usr/bin/env bun
/**
 * cookiedclaw Telegram channel — entry point.
 *
 * Acts as a Claude Code "channel" MCP server: forwards Telegram DMs into
 * the running CC session as `<channel source="telegram" ...>` events,
 * exposes `reply` / `react` / `pair` / `revoke_access` / `list_access`
 * tools, relays CC's permission prompts to Telegram with Allow/Deny
 * buttons, and edits a live tool-progress message in chat via
 * Pre/PostToolUse hooks → localhost endpoint.
 *
 * This file is wiring only. Each concern lives in its own module:
 *   paths.ts         filesystem layout, dlog
 *   env.ts           .env loading, token / allowlist resolution
 *   bot.ts           grammy Bot singleton
 *   mcp.ts           McpServer singleton + base instructions
 *   format.ts        MarkdownV2 conversion + sender display name
 *   chat-state.ts    per-chat state, pendingChats, typing, queueEdit
 *   access.ts        pairing flow, allowlist, ~/.cookiedclaw/access.json
 *   attachments.ts   [embed:]/[file:] markers, sendReply, downloads
 *   progress.ts      tool-progress rendering + handleProgress (hook ingress)
 *   tools.ts         registers reply / react / pair / revoke / list
 *   inbound.ts       text/photo/document handlers + /stop fast-path
 *   permission-relay.ts  Allow/Deny inline buttons for CC tool prompts
 *   progress-server.ts   localhost HTTP for hooks/tool-progress.ts
 *   skill-discovery.ts   publishBotMenu — bot menu from CC skills
 *
 * Required env (loaded from ~/.cookiedclaw/keys.env or project .env):
 *   TELEGRAM_BOT_TOKEN     — bot token from @BotFather (legacy
 *                            TELEGRAM_API_TOKEN also accepted)
 *   TELEGRAM_ALLOWED_USERS — optional comma-separated allowlist; if
 *                            empty, the bot starts in pairing-only mode.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAccess } from "./access.ts";
import { bot } from "./bot.ts";
import { allowAll, allowedUsers, hasToken } from "./env.ts";
import { mcp } from "./mcp.ts";
import { startProgressServer } from "./progress-server.ts";
import { publishBotMenu } from "./skill-discovery.ts";

// Side-effect imports: each registers handlers / tools on `mcp` or `bot`.
import "./tools.ts";
import "./inbound.ts";
import "./permission-relay.ts";

await loadAccess();
await startProgressServer();

await mcp.connect(new StdioServerTransport());
console.error("[telegram] mcp connected");

if (hasToken) {
  console.error("[telegram] starting bot polling...");
  void bot.start({
    drop_pending_updates: true,
    // Telegram only delivers reactions / inline-keyboard callbacks if we
    // explicitly subscribe. The default getUpdates set excludes them.
    allowed_updates: [
      "message",
      "edited_message",
      "callback_query",
      "message_reaction",
    ],
    onStart: (info) => {
      console.error(
        `[telegram] bot @${info.username} ready (allowlist size: ${allowAll ? "ALL" : allowedUsers.size})`,
      );
      void publishBotMenu();
    },
  });
} else {
  console.error(
    "[telegram] skipping bot polling (no token). MCP tools + setup skill remain available.",
  );
}
