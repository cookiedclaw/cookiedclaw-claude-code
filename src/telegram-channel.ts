#!/usr/bin/env bun
/**
 * cookiedclaw Telegram channel.
 *
 * Acts as a Claude Code "channel" MCP server: forwards Telegram DMs into
 * the running CC session as `<channel source="telegram" ...>` events, and
 * exposes a `reply` tool so CC can write back. CC handles everything else
 * (model, agent loop, history, tool calls).
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN     — bot token from @BotFather
 *   TELEGRAM_ALLOWED_USERS — comma-separated Telegram user IDs allowed to
 *                            send messages (everyone else is dropped). Set
 *                            to `*` to disable the allowlist for testing
 *                            (NOT recommended — any sender becomes a prompt
 *                            injection vector).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Bot } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("[telegram] TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const allowedRaw = process.env.TELEGRAM_ALLOWED_USERS ?? "";
const allowAll = allowedRaw.trim() === "*";
const allowedUsers = new Set(
  allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (!allowAll && allowedUsers.size === 0) {
  console.error(
    "[telegram] TELEGRAM_ALLOWED_USERS is empty — every message will be dropped. " +
      "Set it to a comma-separated list of Telegram user IDs (or `*` to allow all).",
  );
}

const mcp = new Server(
  { name: "telegram", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      "Telegram messages arrive as <channel source=\"telegram\" chat_id=\"...\" sender=\"...\">. " +
      "To reply, call the `reply` tool with the chat_id from the tag and your message text. " +
      "The chat is private DM with one user — no need for /commands or @mentions in your reply. " +
      "Be conversational, concise, and ground claims in tool results when appropriate.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a message back to the Telegram chat. Pass the `chat_id` from the inbound <channel> tag verbatim.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "Telegram chat ID from the inbound channel tag.",
          },
          text: {
            type: "string",
            description:
              "Reply body. Plain text or basic Markdown; Telegram-flavored escapes still apply.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

const bot = new Bot(token);

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "reply") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const { chat_id, text } = req.params.arguments as {
    chat_id: string;
    text: string;
  };
  try {
    await bot.api.sendMessage(Number(chat_id), text);
    return { content: [{ type: "text", text: "sent" }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] reply failed (chat ${chat_id}): ${msg}`);
    return {
      content: [{ type: "text", text: `failed: ${msg}` }],
      isError: true,
    };
  }
});

bot.on("message:text", async (ctx) => {
  const sender = ctx.from;
  const chat = ctx.chat;
  const text = ctx.message.text;
  if (!sender) return;

  const senderId = String(sender.id);
  if (!allowAll && !allowedUsers.has(senderId)) {
    console.error(
      `[telegram] dropped message from non-allowlisted user ${senderId} (${sender.username ?? sender.first_name ?? "?"})`,
    );
    return;
  }

  const senderLabel =
    sender.username ??
    [sender.first_name, sender.last_name].filter(Boolean).join(" ") ??
    senderId;

  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: text,
        meta: {
          chat_id: String(chat.id),
          sender_id: senderId,
          sender: senderLabel,
        },
      },
    });
  } catch (err) {
    console.error(
      `[telegram] failed to push notification: ${err instanceof Error ? err.message : err}`,
    );
  }
});

bot.catch((err) => {
  console.error(`[telegram] grammy error: ${err.message}`);
});

await mcp.connect(new StdioServerTransport());
console.error("[telegram] mcp connected, starting bot polling...");

void bot.start({
  drop_pending_updates: true,
  onStart: (info) => {
    console.error(
      `[telegram] bot @${info.username} ready (allowlist size: ${allowAll ? "ALL" : allowedUsers.size})`,
    );
  },
});
