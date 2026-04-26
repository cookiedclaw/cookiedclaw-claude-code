/**
 * Telegram inbound handlers — text, photo, document — plus the gating
 * (allowlist + pair-flow), forwarding to CC, and the /stop fast-path.
 *
 * Importing this module registers the bot.on handlers as a side effect.
 * No exports needed; telegram-channel.ts imports for side effects.
 */
import {
  generatePairCode,
  isAllowed,
  PAIR_TTL_MS,
  pendingPairs,
  reapPending,
} from "./access.ts";
import { downloadTelegramFile } from "./attachments.ts";
import { bot } from "./bot.ts";
import {
  chats,
  pendingChats,
  setActiveChatId,
  startTyping,
  stopTyping,
} from "./chat-state.ts";
import { sendFormatted, senderDisplayName } from "./format.ts";
import { mcp } from "./mcp.ts";
import { dlog, stopFlag } from "./paths.ts";
import { deleteProgressMessage } from "./progress.ts";
import { formatSkillsListMessage } from "./skill-discovery.ts";
import { unlink } from "node:fs/promises";

/**
 * Forward an inbound user message into CC's session as a `<channel>`
 * notification. Sets active chat (for permission-relay routing), adds
 * to pendingChats (for progress fan-out), resets this chat's tool log,
 * and starts the typing indicator.
 *
 * `messageId` is surfaced to CC via meta so the `react` tool can target
 * it (you can't react to a message without knowing its id).
 */
async function forwardToCC(
  chatId: string,
  senderId: string,
  senderLabel: string,
  messageId: number,
  content: string,
  attachmentPath?: string,
): Promise<void> {
  setActiveChatId(chatId);
  pendingChats.add(chatId);
  // Reset this chat's tool log — it's the start of their turn. Other
  // pending chats keep whatever they had. Mutate the existing state
  // object instead of replacing it: replacing would orphan a typing
  // interval started by an earlier forwardToCC, leaking a setInterval
  // that pings "typing..." forever.
  let state = chats.get(chatId);
  if (state) {
    state.events = [];
    state.progressMessageId = undefined;
  } else {
    state = { events: [] };
    chats.set(chatId, state);
  }
  // New user message = clear any /stop flag from a prior turn so the
  // PreToolUse hook stops blocking non-reply tools.
  unlink(stopFlag).catch(() => {});
  startTyping(chatId);
  dlog(
    `inbound: chat=${chatId} sender=${senderId} msg=${messageId}${attachmentPath ? ` attachment=${attachmentPath}` : ""}`,
  );
  const meta: Record<string, string> = {
    chat_id: chatId,
    sender_id: senderId,
    sender: senderLabel,
    message_id: String(messageId),
  };
  if (attachmentPath) meta.attachment = attachmentPath;
  // Prefix the content with [<sender>]: so the agent reliably knows
  // who's talking. The sender is also in meta, but inline prefixes are
  // harder to overlook than tag attributes — and they matter when
  // multiple paired users share the same bot. Empty content (e.g. a
  // photo with no caption) gets no prefix; meta.sender still carries
  // the attribution.
  const prefixedContent = content.trim()
    ? `[${senderLabel}]: ${content}`
    : content;
  try {
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: { content: prefixedContent, meta },
    });
  } catch (err) {
    console.error(
      `[telegram] failed to push notification: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * First gate any inbound message goes through. If sender isn't on the
 * allowlist, issue/refresh a pair code and stop. Returns `{ ok: true,
 * ... }` when the caller should proceed with normal forwarding.
 */
async function gateInbound(ctx: {
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  chat: { id: number };
}): Promise<
  { ok: true; senderId: string; senderLabel: string } | { ok: false }
> {
  const sender = ctx.from;
  if (!sender) return { ok: false };
  const senderId = String(sender.id);
  const senderLabel = senderDisplayName(sender);
  if (isAllowed(sender.id)) return { ok: true, senderId, senderLabel };

  reapPending();
  let pair = [...pendingPairs.values()].find((p) => p.userId === sender.id);
  if (!pair || pair.expiresAt <= Date.now()) {
    pair = {
      code: generatePairCode(),
      userId: sender.id,
      name: senderLabel,
      expiresAt: Date.now() + PAIR_TTL_MS,
    };
    pendingPairs.set(pair.code, pair);
  }
  try {
    await sendFormatted(
      ctx.chat.id,
      `Hi! Your access isn't approved yet.\n\n` +
        `Ask the bot owner to run this in their Claude Code session:\n` +
        `\`pair ${pair.code}\`\n\n` +
        `(code expires in 10 min)`,
    );
  } catch (err) {
    console.error(
      `[telegram] couldn't send pair instructions to ${senderId}: ${err instanceof Error ? err.message : err}`,
    );
  }
  dlog(`pair issued: code=${pair.code} sender=${senderId}`);
  return { ok: false };
}

/**
 * `/stop` (or `/cancel`) — user wants to abort whatever the agent is
 * doing right now. Server-side we kill the typing indicator and drop
 * the progress message immediately so the user gets visual feedback
 * without waiting for the agent to react. Then we push a channel event
 * with `meta.is_stop="true"` so CC's next turn sees the explicit stop
 * signal — its instructions (in CLAUDE.md) tell it to abort and ack.
 */
async function handleStopCommand(
  chatId: string,
  senderId: string,
  senderLabel: string,
  messageId: number,
): Promise<void> {
  stopTyping(chatId);
  await deleteProgressMessage(chatId);
  // Reset events in place; replacing the state object would orphan any
  // typing interval a concurrent forwardToCC might have started.
  let state = chats.get(chatId);
  if (state) {
    state.events = [];
    state.progressMessageId = undefined;
  } else {
    state = { events: [] };
    chats.set(chatId, state);
  }
  // Set the /stop flag so the PreToolUse hook starts blocking non-reply
  // tools immediately. The hook reading this is what gives us a real
  // mid-turn abort — CC's notification queue otherwise lets the agent
  // finish the current tool sequence before noticing the stop.
  await Bun.write(stopFlag, String(Date.now())).catch(() => {});
  setActiveChatId(chatId);
  // /stop ends this chat's turn from the user side — agent will ack
  // shortly and we'll remove from pending then. Until then they're
  // still pending so any final-tool progress goes to them.
  pendingChats.add(chatId);
  dlog(`/stop: chat=${chatId} sender=${senderId} msg=${messageId}`);
  try {
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: "/stop",
        meta: {
          chat_id: chatId,
          sender_id: senderId,
          sender: senderLabel,
          message_id: String(messageId),
          is_stop: "true",
        },
      },
    });
  } catch (err) {
    console.error(
      `[telegram] failed to push /stop signal: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// -----------------------------------------------------------------------------
// Bot handler registrations
// -----------------------------------------------------------------------------

bot.on("message:text", async (ctx) => {
  const gated = await gateInbound(ctx);
  if (!gated.ok) return;
  const text = ctx.message.text.trim();
  // /skills doesn't go to CC — we render the list ourselves so the user
  // doesn't burn an agent turn just to see what's available.
  if (text === "/skills") {
    try {
      const msg = await formatSkillsListMessage();
      await sendFormatted(ctx.chat.id, msg);
    } catch (err) {
      console.error(
        `[telegram] /skills failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return;
  }
  // /stop and /cancel get a special path — we want immediate visual
  // feedback (kill typing, drop progress) before CC's reply lands.
  if (text === "/stop" || text === "/cancel") {
    await handleStopCommand(
      String(ctx.chat.id),
      gated.senderId,
      gated.senderLabel,
      ctx.message.message_id,
    );
    return;
  }
  await forwardToCC(
    String(ctx.chat.id),
    gated.senderId,
    gated.senderLabel,
    ctx.message.message_id,
    ctx.message.text,
  );
});

bot.on("message:photo", async (ctx) => {
  const gated = await gateInbound(ctx);
  if (!gated.ok) return;
  // Telegram returns thumbnail variants in ascending size order; pick the
  // last one (largest available — usually still under a few MB so fits
  // comfortably in CC's vision context).
  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];
  if (!largest) return;
  let attachmentPath: string | undefined;
  try {
    attachmentPath = await downloadTelegramFile(
      largest.file_id,
      `photo_${ctx.message.message_id}.jpg`,
    );
  } catch (err) {
    console.error(
      `[telegram] photo download failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  await forwardToCC(
    String(ctx.chat.id),
    gated.senderId,
    gated.senderLabel,
    ctx.message.message_id,
    ctx.message.caption ?? "",
    attachmentPath,
  );
});

bot.on("message:document", async (ctx) => {
  const gated = await gateInbound(ctx);
  if (!gated.ok) return;
  const doc = ctx.message.document;
  let attachmentPath: string | undefined;
  try {
    attachmentPath = await downloadTelegramFile(
      doc.file_id,
      doc.file_name ?? `file_${ctx.message.message_id}`,
    );
  } catch (err) {
    console.error(
      `[telegram] document download failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  await forwardToCC(
    String(ctx.chat.id),
    gated.senderId,
    gated.senderLabel,
    ctx.message.message_id,
    ctx.message.caption ?? "",
    attachmentPath,
  );
});
