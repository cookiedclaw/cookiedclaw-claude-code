/**
 * Tool registrations on the McpServer: reply, react, pair, revoke_access,
 * list_access. Imported and called once from telegram-channel.ts; lives
 * here to keep the entry point lean.
 */
import { z } from "zod";
import {
  pairedUsers,
  pendingPairs,
  reapPending,
  saveAccess,
} from "./access.ts";
import { extractEmbeds, sendReply } from "./attachments.ts";
import { bot } from "./bot.ts";
import { chats, pendingChats, stopTyping } from "./chat-state.ts";
import { allowAll, allowedUsers } from "./env.ts";
import { sendFormatted } from "./format.ts";
import { mcp } from "./mcp.ts";
import { deleteProgressMessage } from "./progress.ts";

// -----------------------------------------------------------------------------
// reply
// -----------------------------------------------------------------------------

mcp.registerTool(
  "reply",
  {
    description:
      "Send a message back to the Telegram chat. Pass the `chat_id` from the inbound <channel> tag verbatim.",
    inputSchema: {
      chat_id: z
        .string()
        .describe("Telegram chat ID from the inbound channel tag."),
      text: z
        .string()
        .describe(
          "Reply body. Write standard CommonMark Markdown freely — bold (**…**), italic (*…*), inline `code`, ```code blocks```, [links](url), bullet lists, etc. The channel converts to Telegram MarkdownV2 and handles escaping. Tables aren't rendered by Telegram; use bullet lists instead.\n\n" +
            "To attach files inline, include `[embed:<path-or-url>]` (auto: photo for images, document for other files) or `[file:<path-or-url>]` (always document, no compression). The markers are extracted from the visible text before sending. Examples: 'Here's the chart: [embed:./chart.png]' or 'Original: [file:/tmp/photo.png]'.",
        ),
    },
  },
  async ({ chat_id, text }) => {
    // CC is done thinking — drop the typing indicator before the bubble lands,
    // and replace the in-place progress log with a fresh reply bubble.
    stopTyping(chat_id);
    await deleteProgressMessage(chat_id);
    try {
      const { embeds, cleaned } = extractEmbeds(text);
      await sendReply(Number(chat_id), cleaned, embeds);
      // A second user message may have arrived during the await above and
      // started a fresh typing interval. Stop again so we don't leak that
      // interval when we reset state below. (Idempotent if nothing's running.)
      stopTyping(chat_id);
      // Turn done for this chat — drop from pending so further hook
      // events stop fanning out to it. Reset events in place rather than
      // replacing the state object so we don't orphan any typing reference
      // a concurrent forwardToCC might still hold.
      pendingChats.delete(chat_id);
      const state = chats.get(chat_id);
      if (state) {
        state.events = [];
        state.progressMessageId = undefined;
      }
      const note =
        embeds.length > 0
          ? `sent (text + ${embeds.length} attachment${embeds.length === 1 ? "" : "s"})`
          : "sent";
      return { content: [{ type: "text", text: note }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] reply failed (chat ${chat_id}): ${msg}`);
      return {
        content: [{ type: "text", text: `failed: ${msg}` }],
        isError: true,
      };
    }
  },
);

// -----------------------------------------------------------------------------
// react
// -----------------------------------------------------------------------------

mcp.registerTool(
  "react",
  {
    description:
      'Add an emoji reaction to the user\'s inbound message instead of sending a full text reply. Use this for short acknowledgments ("thanks", "got it", "ok", "cool") where a generated reply would just be noise — the reaction shows the user you saw their message and ends the turn cleanly. Don\'t use for substantive responses; use `reply` for those. ' +
      "Allowed emojis are limited to Telegram's curated standard set: 👍 👎 ❤️ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤️‍🔥 🌚 🌭 💯 🤣 ⚡️ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍️ 🤗 🫡 🎅 🎄 ☃️ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂️ 🤷 🤷‍♀️ 😡. Custom/premium emoji are not supported here.",
    inputSchema: {
      chat_id: z
        .string()
        .describe("Telegram chat ID from the inbound channel tag."),
      message_id: z
        .string()
        .describe(
          "Telegram message_id from the inbound channel tag — this is the user's message you're reacting to.",
        ),
      emoji: z
        .string()
        .describe(
          "A single emoji from Telegram's allowed list (see tool description). One emoji per call.",
        ),
    },
  },
  async ({ chat_id, message_id, emoji }) => {
    stopTyping(chat_id);
    await deleteProgressMessage(chat_id);
    try {
      // grammy types `emoji` as a strict union of Telegram's allowed
      // literals; we accept any string from CC and let Telegram reject
      // if it's not on the curated list.
      await bot.api.setMessageReaction(Number(chat_id), Number(message_id), [
        { type: "emoji", emoji } as unknown as Parameters<
          typeof bot.api.setMessageReaction
        >[2][number],
      ]);
      // See `reply` — clear typing again in case a concurrent inbound
      // started a fresh interval during the API await above.
      stopTyping(chat_id);
      pendingChats.delete(chat_id);
      const state = chats.get(chat_id);
      if (state) {
        state.events = [];
        state.progressMessageId = undefined;
      }
      return { content: [{ type: "text", text: `reacted with ${emoji}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[telegram] react failed (chat ${chat_id} msg ${message_id} emoji ${emoji}): ${msg}`,
      );
      return {
        content: [{ type: "text", text: `failed: ${msg}` }],
        isError: true,
      };
    }
  },
);

// -----------------------------------------------------------------------------
// pair / revoke_access / list_access
// -----------------------------------------------------------------------------

mcp.registerTool(
  "pair",
  {
    description:
      "Approve a pending Telegram pairing request by its 5-letter code. When someone DMs the bot but isn't on the allowlist, the bot replies with a code and tells them to ask the owner. The owner relays the code here. After approval, that sender can message normally — the bot will start forwarding their messages into this session.",
    inputSchema: {
      code: z
        .string()
        .describe("5-letter pairing code from the bot's reply (case-insensitive)."),
    },
  },
  async ({ code }) => {
    reapPending();
    const normalized = code.toLowerCase().trim();
    const pending = pendingPairs.get(normalized);
    if (!pending) {
      return {
        content: [
          {
            type: "text",
            text: `No pending pairing for code "${normalized}". Codes expire after 10 minutes — ask the user to DM the bot again to get a fresh one.`,
          },
        ],
        isError: true,
      };
    }
    pendingPairs.delete(normalized);
    pairedUsers.set(pending.userId, {
      userId: pending.userId,
      name: pending.name,
      addedAt: Date.now(),
    });
    await saveAccess();
    try {
      await sendFormatted(
        pending.userId,
        `✓ You're approved. Send me a message and I'll forward it to Claude.`,
      );
    } catch {
      // best-effort
    }
    return {
      content: [
        {
          type: "text",
          text: `✓ Approved ${pending.name} (id ${pending.userId}). They can message the bot now.`,
        },
      ],
    };
  },
);

mcp.registerTool(
  "revoke_access",
  {
    description:
      "Revoke a previously paired Telegram user's access. Their future messages will be dropped silently.",
    inputSchema: {
      user_id: z
        .string()
        .describe("Telegram numeric user ID to revoke (find via `list_access`)."),
    },
  },
  async ({ user_id }) => {
    const userId = Number(user_id.trim());
    if (!Number.isFinite(userId)) {
      return {
        content: [
          { type: "text", text: `user_id must be numeric, got "${user_id}"` },
        ],
        isError: true,
      };
    }
    const had = pairedUsers.delete(userId);
    if (had) await saveAccess();
    return {
      content: [
        {
          type: "text",
          text: had
            ? `Revoked user ${userId}. Their messages will be dropped.`
            : `User ${userId} wasn't on the paired list (env-bypassed users can't be revoked here — edit TELEGRAM_ALLOWED_USERS instead).`,
        },
      ],
    };
  },
);

mcp.registerTool(
  "list_access",
  {
    description:
      "List everyone with Telegram access right now: env-based static allowlist, paired runtime users, and any pending pairing requests still waiting for approval.",
    inputSchema: {},
  },
  async () => {
    reapPending();
    const lines: string[] = [];
    if (allowAll) {
      lines.push("Static (env): ALL — TELEGRAM_ALLOWED_USERS=*");
    } else if (allowedUsers.size > 0) {
      lines.push(`Static (env): ${[...allowedUsers].join(", ")}`);
    } else {
      lines.push("Static (env): (none — pairing-only mode)");
    }

    if (pairedUsers.size > 0) {
      lines.push("", `Paired (${pairedUsers.size}):`);
      for (const u of pairedUsers.values()) {
        const added = new Date(u.addedAt).toISOString().slice(0, 10);
        lines.push(`  • ${u.name} — id ${u.userId} (added ${added})`);
      }
    } else {
      lines.push("", "Paired: (none)");
    }

    if (pendingPairs.size > 0) {
      lines.push("", "Pending pairing:");
      for (const p of pendingPairs.values()) {
        const minsLeft = Math.max(
          0,
          Math.round((p.expiresAt - Date.now()) / 60000),
        );
        lines.push(
          `  • ${p.name} — id ${p.userId}, code ${p.code} (${minsLeft}m left)`,
        );
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);
