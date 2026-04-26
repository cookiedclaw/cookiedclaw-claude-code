/**
 * Per-chat runtime state: tool-event log, progress message id, typing
 * timers, plus the `pendingChats` set and an edit-serializing queue.
 *
 * Tool-progress hooks fire without chat correlation, so we BROADCAST
 * to every chat in `pendingChats`. Each chat keeps its own copy of
 * the events list — when one gets a reply and its events reset, the
 * others aren't disturbed.
 */
import { bot } from "./bot.ts";

export type ToolEvent = {
  toolUseId: string;
  toolName: string;
  inputSummary: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  errorText?: string;
};

export type ChatState = {
  /** Telegram message_id of the live progress block (we edit this in place). */
  progressMessageId?: number;
  events: ToolEvent[];
  /** Active "typing…" indicator handles, cleared on reply or failsafe. */
  typing?: {
    interval: ReturnType<typeof setInterval>;
    failsafe: ReturnType<typeof setTimeout>;
  };
};

export const chats = new Map<string, ChatState>();

/**
 * Every chat with an unanswered message lives here. Hook events fan
 * out to all of them so users with queued messages see "the bot is
 * working" instead of silently waiting. A chat leaves the set when
 * CC calls `reply` or `react` for it.
 */
export const pendingChats = new Set<string>();

/**
 * Last-inbound chat id, used ONLY for routing permission relay prompts
 * (we have to send the Allow/Deny buttons SOMEWHERE, and the most
 * recently inbound chat is the closest proxy for "whose turn CC is
 * processing"). Progress / typing use the broader pendingChats set.
 */
export let activeChatId: string | undefined;
export function setActiveChatId(chatId: string): void {
  activeChatId = chatId;
}

// -----------------------------------------------------------------------------
// Edit serialization
// -----------------------------------------------------------------------------

const editQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize Telegram edits per chat so concurrent hook events don't race
 * the API and produce out-of-order updates.
 */
export function queueEdit<T>(
  chatId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = editQueues.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  editQueues.set(
    chatId,
    next.catch(() => {}),
  );
  return next;
}

// -----------------------------------------------------------------------------
// Typing indicator (per-chat lifetime, refreshed every 4.5s)
// -----------------------------------------------------------------------------

/**
 * Telegram's `sendChatAction("typing")` signal lasts ~5 seconds, so we
 * refresh it every 4.5s while CC is working. Started on inbound and
 * cleared by `reply`/`react`/`/stop` (or by a 5-minute failsafe if
 * none of those fire).
 */
export function startTyping(chatId: string): void {
  const state = chats.get(chatId);
  if (!state || state.typing) return;
  const ping = () => {
    bot.api.sendChatAction(Number(chatId), "typing").catch(() => {});
  };
  ping();
  const interval = setInterval(ping, 4500);
  const failsafe = setTimeout(() => stopTyping(chatId), 5 * 60 * 1000);
  state.typing = { interval, failsafe };
}

export function stopTyping(chatId: string): void {
  const state = chats.get(chatId);
  if (!state?.typing) return;
  clearInterval(state.typing.interval);
  clearTimeout(state.typing.failsafe);
  state.typing = undefined;
}
