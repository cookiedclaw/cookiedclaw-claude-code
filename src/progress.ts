/**
 * Live tool-progress rendering. Hook events (PreToolUse / PostToolUse,
 * delivered via the localhost endpoint in progress-server.ts) feed
 * `handleProgress`, which fans out to every chat in `pendingChats` so
 * concurrent users all see the bot is working.
 */
import { bot } from "./bot.ts";
import {
  chats,
  pendingChats,
  queueEdit,
  stopTyping,
  type ChatState,
  type ToolEvent,
} from "./chat-state.ts";
import { dlog } from "./paths.ts";

// -----------------------------------------------------------------------------
// Formatting helpers (pure)
// -----------------------------------------------------------------------------

function clamp(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * Pick a short, informative summary of a tool's input for the progress
 * line. Knows the most common CC tools and falls back to compact JSON.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (name === "Bash" && typeof obj.command === "string") {
      return clamp(obj.command, 90);
    }
    if (
      (name === "Read" ||
        name === "Edit" ||
        name === "Write" ||
        name === "NotebookEdit") &&
      typeof obj.file_path === "string"
    ) {
      return obj.file_path;
    }
    if (name === "Glob" && typeof obj.pattern === "string") return obj.pattern;
    if (name === "Grep" && typeof obj.pattern === "string") return obj.pattern;
    if (name === "WebFetch" && typeof obj.url === "string") return obj.url;
    if (name === "WebSearch" && typeof obj.query === "string") return obj.query;
    if (name === "Agent" && typeof obj.subagent_type === "string") {
      return `${obj.subagent_type}: ${typeof obj.prompt === "string" ? clamp(obj.prompt, 60) : ""}`;
    }
    // Generic: show the first short string-valued field, or compact JSON.
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.length <= 90) return `${k}=${v}`;
    }
  }
  const json = JSON.stringify(input ?? {});
  return clamp(json, 90);
}

/**
 * Skip our `reply` tool from the progress log — it's the final output
 * channel, not "progress". CC namespaces it differently depending on
 * load context: plain `reply` (direct call from main session, rare),
 * `mcp__telegram__reply` (when loaded via .mcp.json), or
 * `mcp__plugin_<plugin>_<server>__reply` (when loaded via --plugin-dir).
 */
export function isReplyTool(name: string): boolean {
  return name === "reply" || /^mcp__.+__reply$/.test(name);
}

function renderProgress(events: ToolEvent[]): string {
  if (events.length === 0) return "🔧 working…";
  return events
    .map((e) => {
      const icon =
        e.status === "running" ? "⏳" : e.status === "done" ? "✓" : "✗";
      const dur = e.durationMs ? ` (${formatDuration(e.durationMs)})` : "";
      const errPart = e.errorText ? ` — ${clamp(e.errorText, 80)}` : "";
      return `${icon} ${e.toolName}: ${e.inputSummary}${dur}${errPart}`;
    })
    .join("\n");
}

/**
 * Push a chat's current event list to Telegram — either send a fresh
 * progress message (first tool of the turn) or edit the existing one
 * in place. Best-effort: rate limits and "message not modified" errors
 * are logged and swallowed so a flaky network doesn't break the loop.
 */
export async function pushProgress(chatId: string): Promise<void> {
  const state = chats.get(chatId);
  if (!state) return;
  const text = renderProgress(state.events);
  if (!text) return;
  try {
    if (state.progressMessageId !== undefined) {
      await bot.api.editMessageText(
        Number(chatId),
        state.progressMessageId,
        text,
      );
    } else {
      const sent = await bot.api.sendMessage(Number(chatId), text);
      state.progressMessageId = sent.message_id;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("message is not modified")) {
      console.error(`[telegram] progress push failed: ${msg}`);
    }
  }
}

/**
 * Drop the in-place progress message for `chatId` if any. Used by
 * `reply` / `react` / `/stop` when the turn's done — the progress log
 * is replaced by the final answer, not left dangling above it.
 */
export async function deleteProgressMessage(chatId: string): Promise<void> {
  await queueEdit(chatId, async () => {
    const state = chats.get(chatId);
    if (state?.progressMessageId === undefined) return;
    try {
      await bot.api.deleteMessage(
        Number(chatId),
        state.progressMessageId,
      );
    } catch (err) {
      console.error(
        `[telegram] couldn't delete progress message: ${err instanceof Error ? err.message : err}`,
      );
    }
    state.progressMessageId = undefined;
  });
}

// -----------------------------------------------------------------------------
// Hook event ingestion
// -----------------------------------------------------------------------------

export type ProgressPayload =
  | {
      phase: "pre" | "post";
      tool_name: string;
      tool_use_id: string;
      tool_input?: unknown;
      duration_ms?: number;
      is_error?: boolean;
      error_text?: string;
    }
  | {
      /** Turn-end signal from the Stop hook. No tool data — we just clear
       * typing + drop the progress message + remove from pendingChats. */
      phase: "stop";
    };

/**
 * Apply a single hook event to one chat's events list, then schedule
 * a progress push. Adds for `pre`, updates the matching `pre` for
 * `post` (or pushes a standalone done/error if there's no match —
 * defensive for chats that joined pending mid-flight).
 */
function applyEvent(
  state: ChatState,
  p: Extract<ProgressPayload, { phase: "pre" | "post" }>,
): void {
  if (p.phase === "pre") {
    state.events.push({
      toolUseId: p.tool_use_id,
      toolName: p.tool_name,
      inputSummary: summarizeToolInput(p.tool_name, p.tool_input),
      status: "running",
    });
    return;
  }
  const ev = state.events.find((e) => e.toolUseId === p.tool_use_id);
  if (ev) {
    ev.status = p.is_error ? "error" : "done";
    ev.durationMs = p.duration_ms;
    if (p.error_text) ev.errorText = p.error_text;
  } else {
    state.events.push({
      toolUseId: p.tool_use_id,
      toolName: p.tool_name,
      inputSummary: summarizeToolInput(p.tool_name, p.tool_input),
      status: p.is_error ? "error" : "done",
      durationMs: p.duration_ms,
      errorText: p.error_text,
    });
  }
}

/**
 * Top-level hook ingest. Three phases:
 *  - `stop`: agent ended its turn — drop typing, delete progress
 *    message, clear pendingChats. This is the authoritative
 *    "agent is done" signal.
 *  - `pre` / `post`: tool progress event. Skips our own `reply`/`react`
 *    tools (they're the final output, not progress) and broadcasts to
 *    every chat in `pendingChats`.
 */
export async function handleProgress(p: ProgressPayload): Promise<void> {
  if (p.phase === "stop") {
    dlog(
      `stop hook fired — clearing pending=[${[...pendingChats].join(",") || "none"}]`,
    );
    const toClear = [...pendingChats];
    pendingChats.clear();
    for (const chatId of toClear) {
      stopTyping(chatId);
      void deleteProgressMessage(chatId);
      const state = chats.get(chatId);
      if (state) {
        state.events = [];
        state.progressMessageId = undefined;
      }
    }
    return;
  }
  dlog(
    `progress in: phase=${p.phase} tool=${p.tool_name} id=${p.tool_use_id} pending=[${[...pendingChats].join(",") || "none"}]`,
  );
  if (isReplyTool(p.tool_name)) {
    dlog(`  -> skipped (reply tool)`);
    return;
  }
  if (pendingChats.size === 0) {
    dlog(`  -> skipped (no pending chats)`);
    return;
  }
  for (const chatId of pendingChats) {
    const state = chats.get(chatId) ?? { events: [] };
    chats.set(chatId, state);
    applyEvent(state, p);
    void queueEdit(chatId, () => pushProgress(chatId));
  }
}
