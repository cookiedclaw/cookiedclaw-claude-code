#!/usr/bin/env bun
/**
 * cookiedclaw Telegram channel.
 *
 * Acts as a Claude Code "channel" MCP server: forwards Telegram DMs into
 * the running CC session as `<channel source="telegram" ...>` events, and
 * exposes a `reply` tool so CC can write back. CC handles everything else
 * (model, agent loop, history, tool calls).
 *
 * Live tool progress: a localhost HTTP listener accepts POSTs from the
 * `hooks/tool-progress.ts` PreToolUse / PostToolUse hook. As CC runs
 * tools we edit a single Telegram message in place ("⏳ Bash: ls -la"
 * → "✓ Bash: ls -la (120ms)"), so the user sees what's happening
 * instead of staring at silence until the final reply lands.
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN     — bot token from @BotFather
 *   TELEGRAM_ALLOWED_USERS — comma-separated Telegram user IDs allowed to
 *                            send messages (everyone else is dropped). Set
 *                            to `*` to disable the allowlist for testing
 *                            (NOT recommended — any sender becomes a prompt
 *                            injection vector).
 */
import { appendFile, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import matter from "gray-matter";
import telegramifyMarkdown from "telegramify-markdown";
import { z } from "zod";

// -----------------------------------------------------------------------------
// Env loading
// -----------------------------------------------------------------------------

const projectRoot = resolve(import.meta.dir, "..");
// Two sources, in priority order: the user-level keys file (where the
// /cookiedclaw:setup wizard writes everything — survives plugin upgrades
// and works regardless of cwd) takes precedence over the project's .env
// (legacy / dev-mode source). Shell env still wins over both because we
// only set keys that aren't already in process.env.
const envPaths = [
  resolve(process.env.HOME ?? "/", ".cookiedclaw", "keys.env"),
  resolve(projectRoot, ".env"),
];
for (const envPath of envPaths) {
  const envFile = Bun.file(envPath);
  if (!(await envFile.exists())) continue;
  const envText = await envFile.text();
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const [, key, rawValue] = m as unknown as [string, string, string];
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
  console.error(`[telegram] loaded env from ${envPath}`);
}

const token =
  process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_API_TOKEN;
const hasToken = Boolean(token);
if (!hasToken) {
  // First-run case: user installed cookiedclaw but hasn't gone through
  // setup yet. We MUST stay alive — otherwise the plugin's MCP server
  // dies and the /cookiedclaw:setup skill (the thing that fixes this)
  // becomes unreachable from CC. So: log a friendly note, skip bot
  // polling, but keep the MCP server up so its tools and the setup
  // skill stay available.
  console.error(
    `[telegram] no Telegram bot token yet — bot polling disabled.\n` +
      `  Run /cookiedclaw:setup in Claude Code to configure one,\n` +
      `  then restart claude. MCP tools (pair, list_access, …) and the\n` +
      `  setup skill stay available in the meantime.`,
  );
}

const allowedRaw = process.env.TELEGRAM_ALLOWED_USERS ?? "";
const allowAll = allowedRaw.trim() === "*";
const allowedUsers = new Set(
  allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// -----------------------------------------------------------------------------
// Access management: env-based static allowlist + persistent paired users
//                    + transient pairing requests
// -----------------------------------------------------------------------------

type PairedUser = { userId: number; name: string; addedAt: number };
type PendingPair = {
  code: string;
  userId: number;
  name: string;
  expiresAt: number;
};

// We initialize accessFile after dataDir is set up below, but declare here.
let accessFile = "";
const pairedUsers = new Map<number, PairedUser>();
/** Pending pair requests keyed by code (lowercased). */
const pendingPairs = new Map<string, PendingPair>();

const PAIR_TTL_MS = 10 * 60 * 1000;

function generatePairCode(): string {
  // Same alphabet as CC's permission relay codes: lowercase a-z minus 'l',
  // so it never reads as '1'/'I' on a phone screen. 5 chars = ~12M codes,
  // collision odds for the few pending requests we'll ever have are ~zero.
  const alphabet = "abcdefghijkmnopqrstuvwxyz";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function reapPending(): void {
  const now = Date.now();
  for (const [code, p] of pendingPairs) {
    if (p.expiresAt < now) pendingPairs.delete(code);
  }
}

async function loadAccess(): Promise<void> {
  try {
    const text = await Bun.file(accessFile).text();
    const data = JSON.parse(text) as { paired?: PairedUser[] };
    for (const u of data.paired ?? []) pairedUsers.set(u.userId, u);
    console.error(
      `[telegram] loaded ${pairedUsers.size} paired user(s) from ${accessFile}`,
    );
  } catch {
    // file doesn't exist yet — fine, fresh install
  }
}

async function saveAccess(): Promise<void> {
  await Bun.write(
    accessFile,
    JSON.stringify({ paired: [...pairedUsers.values()] }, null, 2),
  );
}

function isAllowed(userId: number): boolean {
  if (allowAll) return true;
  if (allowedUsers.has(String(userId))) return true; // env bypass for owner
  return pairedUsers.has(userId);
}

function senderDisplayName(sender: {
  username?: string;
  first_name?: string;
  last_name?: string;
  id: number;
}): string {
  if (sender.username) return `@${sender.username}`;
  const full = [sender.first_name, sender.last_name].filter(Boolean).join(" ");
  return full || String(sender.id);
}

if (!allowAll && allowedUsers.size === 0) {
  console.error(
    "[telegram] TELEGRAM_ALLOWED_USERS is empty — bot starts in pairing-only mode. " +
      "Anyone who DMs the bot will get a code; ask Claude to `pair <code>` to approve them. " +
      "(Or set TELEGRAM_ALLOWED_USERS=<your_user_id> for an env-based bypass.)",
  );
}

// -----------------------------------------------------------------------------
// Per-chat state for live tool progress
// -----------------------------------------------------------------------------

type ToolEvent = {
  toolUseId: string;
  toolName: string;
  inputSummary: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  errorText?: string;
};

type ChatState = {
  /** Telegram message_id of the live progress block (we edit this in place). */
  progressMessageId?: number;
  events: ToolEvent[];
  /** Active "typing…" indicator handles, cleared on reply or failsafe. */
  typing?: {
    interval: ReturnType<typeof setInterval>;
    failsafe: ReturnType<typeof setTimeout>;
  };
};

/**
 * Telegram's `sendChatAction("typing")` signal lasts ~5 seconds, so we
 * refresh it every 4.5s while CC is working. Started on inbound and
 * cleared by `reply` (or by a 5-minute failsafe if CC never replies).
 */
function startTyping(chatId: string): void {
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

function stopTyping(chatId: string): void {
  const state = chats.get(chatId);
  if (!state?.typing) return;
  clearInterval(state.typing.interval);
  clearTimeout(state.typing.failsafe);
  state.typing = undefined;
}

const chats = new Map<string, ChatState>();

/**
 * Hooks don't know which Telegram chat triggered the current CC turn — they
 * only see `tool_name` / `tool_input`. We track "the chat CC is currently
 * working on" by remembering the last inbound message's chat_id and resetting
 * on each new inbound. Single-chat scenario is solid; multi-chat under one
 * session can race, but for one user this is fine.
 */
let activeChatId: string | undefined;

/** Per-chat serialized edit queue so concurrent hooks don't race Telegram API. */
const editQueues = new Map<string, Promise<unknown>>();
function queueEdit<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = editQueues.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  editQueues.set(
    chatId,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Skip our `reply` tool from the progress log — it's the final output
 * channel, not "progress". CC namespaces it differently depending on
 * load context: plain `reply` (direct call from main session, rare),
 * `mcp__telegram__reply` (when loaded via .mcp.json), or
 * `mcp__plugin_<plugin>_<server>__reply` (when loaded via --plugin-dir).
 * The scope between `mcp__` and `__reply` can contain underscores, so
 * accept anything in there.
 */
function isReplyTool(name: string): boolean {
  return name === "reply" || /^mcp__.+__reply$/.test(name);
}

function summarizeToolInput(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Common CC tools — pick the most informative single field.
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

function clamp(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

// -----------------------------------------------------------------------------
// Outbound attachments — [embed:path] / [file:path] markers in reply text
// -----------------------------------------------------------------------------

type Embed = { kind: "auto" | "file"; source: string };

const EMBED_REGEX = /\[(embed|file):([^\]\n]+)\]/g;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)(\?|$)/i;

function looksLikeImage(source: string, mediaType?: string): boolean {
  if (mediaType?.startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(source);
}

/**
 * Heuristic: does this marker payload actually look like a file path or
 * URL we should attach? Catches cases where the model writes
 * `[embed:path]` or `[file:filename]` as inline syntax explanation
 * (e.g. when describing how the markers work) rather than as a real
 * dispatch instruction.
 *
 * Treat as path-ish if it has any of:
 *   - a directory separator (`/` or `\`)
 *   - a leading `~` (home shorthand)
 *   - an http(s):// prefix
 *   - a file extension (3+ chars after a dot near the end)
 */
function looksLikeAttachmentSource(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith("~") || s.includes("/") || s.includes("\\")) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(s)) return true;
  return false;
}

function extractEmbeds(text: string): { embeds: Embed[]; cleaned: string } {
  const embeds: Embed[] = [];
  // Only consume markers that look real; leave unrecognized ones in the
  // text so the user can still see them (and so we don't accidentally
  // strip an explanatory `[embed:...]` from a doc-style answer).
  const cleaned = text
    .replace(EMBED_REGEX, (full, tag: string, src: string) => {
      const source = src.trim();
      if (!looksLikeAttachmentSource(source)) return full;
      embeds.push({ kind: tag === "file" ? "file" : "auto", source });
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
  return { embeds, cleaned };
}

/**
 * Resolve an embed source to a Telegram-uploadable payload. We download
 * URLs ourselves rather than handing them to Telegram, because Telegram's
 * URL fetcher is fragile against signed/CDN URLs (fal.ai, S3 presigned,
 * etc.) and times out on large hosts. Local paths get streamed via
 * InputFile.
 */
async function resolveEmbed(
  source: string,
): Promise<{ file: InputFile; isImage: boolean; sizeBytes?: number }> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`fetch ${source}: HTTP ${res.status}`);
    }
    const mediaType = res.headers.get("content-type") ?? undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const filename =
      source.split(/[?#]/)[0]?.split("/").pop() || "download";
    return {
      file: new InputFile(bytes, filename),
      isImage: looksLikeImage(source, mediaType),
      sizeBytes: bytes.byteLength,
    };
  }
  // Local path — leave it absolute or resolve relative to project root.
  const abs = source.startsWith("/")
    ? source
    : resolve(projectRoot, source);
  const file = Bun.file(abs);
  if (!(await file.exists())) {
    throw new Error(`file not found: ${abs}`);
  }
  return {
    file: new InputFile(abs),
    isImage: looksLikeImage(abs, file.type || undefined),
    sizeBytes: file.size,
  };
}

/** Telegram caption max length (per Bot API). */
const TELEGRAM_CAPTION_LIMIT = 1024;

/**
 * Send the reply text + any extracted attachments. UX strategy:
 *  - One attachment + short text → single sendPhoto/Document with caption
 *    (text appears under the media, no two-message split).
 *  - Anything else → text first, then attachments in order.
 *
 * Failures dispatching individual attachments are logged but never abort
 * the whole reply — the user always at least sees the text answer.
 */
async function sendReply(
  chatId: number,
  text: string,
  embeds: Embed[],
): Promise<void> {
  // Fast path: single embed + caption-able text → combined.
  if (embeds.length === 1 && text.length <= TELEGRAM_CAPTION_LIMIT) {
    const embed = embeds[0]!;
    try {
      const { file, isImage } = await resolveEmbed(embed.source);
      const sendAsPhoto = embed.kind === "auto" && isImage;
      const caption = text ? toTelegramMd(text) : undefined;
      const opts =
        caption !== undefined
          ? { caption, parse_mode: "MarkdownV2" as const }
          : undefined;
      if (sendAsPhoto) {
        await bot.api.sendPhoto(chatId, file, opts);
      } else {
        await bot.api.sendDocument(chatId, file, opts);
      }
      return;
    } catch (err) {
      console.error(
        `[telegram] combined send failed (${embed.source}): ${err instanceof Error ? err.message : err} — falling back to split`,
      );
      // fall through to split path
    }
  }

  if (text) await sendFormatted(chatId, text);

  for (const embed of embeds) {
    try {
      const { file, isImage } = await resolveEmbed(embed.source);
      if (embed.kind === "auto" && isImage) {
        await bot.api.sendPhoto(chatId, file);
      } else {
        await bot.api.sendDocument(chatId, file);
      }
    } catch (err) {
      // Internal failure — log for our own debugging but DON'T pollute
      // the chat with "(couldn't attach...)" notices. If the model wrote
      // a bogus marker, the user shouldn't have to see our plumbing
      // complain about it.
      console.error(
        `[telegram] embed dispatch failed (${embed.source}): ${err instanceof Error ? err.message : err}`,
      );
      dlog(`embed failed: ${embed.source}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Telegram MarkdownV2 helpers (used above + below)
// -----------------------------------------------------------------------------

/**
 * Convert CC's CommonMark-flavored output into something Telegram's
 * MarkdownV2 parser will accept. CC writes \`code\`, **bold**, lists,
 * links, code blocks — Telegram renders them all but is strict about
 * escaping (`. ! - + ( )` etc. all need backslashes when not part of
 * formatting). `telegramify-markdown` does that escaping for us.
 */
function toTelegramMd(text: string): string {
  try {
    return telegramifyMarkdown(text, "escape");
  } catch {
    // If conversion blows up on weird input, fall back to raw text and let
    // the caller's plain-text retry handle it.
    return text;
  }
}

/**
 * Send formatted text with MarkdownV2; if Telegram rejects the markdown
 * (rare edge cases telegramify doesn't catch), retry as plain text so we
 * never silently drop a message just because of escape ambiguity.
 */
async function sendFormatted(chatId: number, text: string): Promise<void> {
  const md = toTelegramMd(text);
  try {
    await bot.api.sendMessage(chatId, md, { parse_mode: "MarkdownV2" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/can't parse|markdown|entities/i.test(msg)) {
      console.error(
        `[telegram] markdown parse error, retrying plain: ${msg}`,
      );
      await bot.api.sendMessage(chatId, text);
    } else {
      throw err;
    }
  }
}

function renderProgress(events: ToolEvent[]): string {
  if (events.length === 0) return "🔧 working…";
  return events
    .map((e) => {
      const icon =
        e.status === "running"
          ? "⏳"
          : e.status === "done"
            ? "✓"
            : "✗";
      const dur = e.durationMs ? ` (${formatDuration(e.durationMs)})` : "";
      const errPart = e.errorText ? ` — ${clamp(e.errorText, 80)}` : "";
      return `${icon} ${e.toolName}: ${e.inputSummary}${dur}${errPart}`;
    })
    .join("\n");
}

/**
 * Push the chat's current event list to Telegram — either send a fresh
 * progress message (first tool of the turn) or edit the existing one in
 * place. Best-effort; rate limits and "message not modified" errors are
 * logged and swallowed so a flaky network never breaks the tool loop.
 */
async function pushProgress(chatId: string): Promise<void> {
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

// -----------------------------------------------------------------------------
// MCP server (channel + reply tool)
// -----------------------------------------------------------------------------

const mcp = new Server(
  { name: "telegram", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        // Permission relay: when CC needs approval for a tool call (Bash,
        // Write, Edit, etc.), CC posts the prompt here too. We forward it
        // to the active chat with Allow/Deny inline buttons so the user
        // can approve from their phone instead of having to be at the
        // terminal. The local terminal dialog stays open in parallel —
        // first answer wins. Only safe to declare because we gate inbound
        // by sender (env allowlist + paired users).
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      'Telegram messages arrive as <channel source="telegram" chat_id="..." sender="..." message_id="..." [attachment="/abs/path"]>. ' +
      "To reply, call the `reply` tool with the chat_id from the tag and your message text. " +
      "The chat is private DM with one user — no need for /commands or @mentions in your reply. " +
      "Be conversational, concise, and ground claims in tool results when appropriate.\n\n" +
      "When to react instead of reply: if the user's message is a short acknowledgment or social closer (\"thanks\", \"got it\", \"ok\", \"cool\", \"спасибо\", \"👍\", \"perfect\"), prefer the `react` tool with a fitting emoji from Telegram's allowed list (👍 ❤️ 🙏 🔥 🎉 etc.) over generating a text reply. Reactions show you saw the message and end the turn cleanly without burning tokens or adding noise. Pass `chat_id` and `message_id` from the inbound channel tag. Only one of `react` / `reply` per turn — they both close out the typing indicator and progress log.\n\n" +
      "Inbound attachments: if the channel tag has an `attachment` attribute, the user attached a file at that absolute path. " +
      "For images/photos, use the Read tool — it handles vision so you can actually see the image. " +
      "For other files (PDFs, docs, audio, etc.), use Read or Bash as appropriate. " +
      "The attachment is local to this machine; treat the path as authoritative.\n\n" +
      "Sending images / files: include `[embed:<absolute-path>]` or `[file:<absolute-path>]` markers in your reply text. " +
      "`embed` auto-detects: image MIMEs go as compressed Telegram photos (rendered inline), everything else as documents. " +
      "`file` always sends as a document (no compression — use for original-quality images or when the user asked 'as a file'). " +
      "URLs work too (`[embed:https://...]`); we download and forward. " +
      "Markers are stripped from the visible text before sending; users see clean text + the attachment.\n\n" +
      "Slash commands from the Telegram menu: when an inbound message starts with `/<cmd>`, the user tapped a command from the bot's menu, which mirrors the skills available in this CC environment. The menu name uses underscores instead of hyphens/colons (e.g. `/cookiedclaw_setup` for the `cookiedclaw:setup` skill, `/code_review` for `code-review`, `/svelte_svelte_code_writer` for `svelte:svelte-code-writer`). Treat this as an explicit invocation of that skill — load and run it.",
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
              "Reply body. Write standard CommonMark Markdown freely — bold (**…**), italic (*…*), inline `code`, ```code blocks```, [links](url), bullet lists, etc. The channel converts to Telegram MarkdownV2 and handles escaping. Tables aren't rendered by Telegram; use bullet lists instead.\n\n" +
              "To attach files inline, include `[embed:<path-or-url>]` (auto: photo for images, document for other files) or `[file:<path-or-url>]` (always document, no compression). The markers are extracted from the visible text before sending. Examples: 'Here's the chart: [embed:./chart.png]' or 'Original: [file:/tmp/photo.png]'.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "react",
      description:
        "Add an emoji reaction to the user's inbound message instead of sending a full text reply. Use this for short acknowledgments (\"thanks\", \"got it\", \"ok\", \"cool\") where a generated reply would just be noise — the reaction shows the user you saw their message and ends the turn cleanly. Don't use for substantive responses; use `reply` for those. " +
        "Allowed emojis are limited to Telegram's curated standard set: 👍 👎 ❤️ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤️‍🔥 🌚 🌭 💯 🤣 ⚡️ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍️ 🤗 🫡 🎅 🎄 ☃️ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂️ 🤷 🤷‍♀️ 😡. Custom/premium emoji are not supported here.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "Telegram chat ID from the inbound channel tag.",
          },
          message_id: {
            type: "string",
            description: "Telegram message_id from the inbound channel tag — this is the user's message you're reacting to.",
          },
          emoji: {
            type: "string",
            description: "A single emoji from Telegram's allowed list (see tool description). One emoji per call.",
          },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "pair",
      description:
        "Approve a pending Telegram pairing request by its 5-letter code. When someone DMs the bot but isn't on the allowlist, the bot replies with a code and tells them to ask the owner. The owner relays the code here. After approval, that sender can message normally — the bot will start forwarding their messages into this session.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "5-letter pairing code from the bot's reply (case-insensitive).",
          },
        },
        required: ["code"],
      },
    },
    {
      name: "revoke_access",
      description:
        "Revoke a previously paired Telegram user's access. Their future messages will be dropped silently.",
      inputSchema: {
        type: "object",
        properties: {
          user_id: {
            type: "string",
            description: "Telegram numeric user ID to revoke (find via `list_access`).",
          },
        },
        required: ["user_id"],
      },
    },
    {
      name: "list_access",
      description:
        "List everyone with Telegram access right now: env-based static allowlist, paired runtime users, and any pending pairing requests still waiting for approval.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// Construct with a placeholder when there's no token yet so the rest of
// the file (which references `bot` from many places) doesn't crash on
// import. We never call bot.start() in that case, so the placeholder
// never hits Telegram. Any stray bot.api.* call would 401 — every
// handler that touches bot.api wraps in try/catch already.
const bot = new Bot(token ?? "0:no-token-yet");

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "reply") {
    const { chat_id, text } = args as { chat_id: string; text: string };
    // CC is done thinking — drop the typing indicator before the bubble lands.
    stopTyping(chat_id);
    // Drop the in-place progress message (its job is done) and send the
    // reply as a fresh Telegram message so a clean log + the answer don't
    // fight for the same bubble.
    await queueEdit(chat_id, async () => {
      const state = chats.get(chat_id);
      if (state?.progressMessageId !== undefined) {
        try {
          await bot.api.deleteMessage(
            Number(chat_id),
            state.progressMessageId,
          );
        } catch (err) {
          console.error(
            `[telegram] couldn't delete progress message: ${err instanceof Error ? err.message : err}`,
          );
        }
        state.progressMessageId = undefined;
      }
    });
    try {
      const { embeds, cleaned } = extractEmbeds(text);
      await sendReply(Number(chat_id), cleaned, embeds);
      // Reset the event list so the next turn starts clean.
      chats.set(chat_id, { events: [] });
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
  }

  if (name === "react") {
    const { chat_id, message_id, emoji } = args as {
      chat_id: string;
      message_id: string;
      emoji: string;
    };
    // Same end-of-turn cleanup as reply: typing off, drop the progress
    // message, reset events. Reacting IS the answer — no follow-up text.
    stopTyping(chat_id);
    await queueEdit(chat_id, async () => {
      const state = chats.get(chat_id);
      if (state?.progressMessageId !== undefined) {
        try {
          await bot.api.deleteMessage(
            Number(chat_id),
            state.progressMessageId,
          );
        } catch (err) {
          console.error(
            `[telegram] couldn't delete progress message before react: ${err instanceof Error ? err.message : err}`,
          );
        }
        state.progressMessageId = undefined;
      }
    });
    try {
      // grammy types `emoji` as a strict union of Telegram's allowed
      // emoji literals; we accept any string from CC at runtime and let
      // Telegram reject if it's not allowed. Cast through unknown here.
      await bot.api.setMessageReaction(Number(chat_id), Number(message_id), [
        { type: "emoji", emoji } as unknown as Parameters<
          typeof bot.api.setMessageReaction
        >[2][number],
      ]);
      chats.set(chat_id, { events: [] });
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
  }

  if (name === "pair") {
    reapPending();
    const code = String((args as { code: string }).code).toLowerCase().trim();
    const pending = pendingPairs.get(code);
    if (!pending) {
      return {
        content: [
          {
            type: "text",
            text: `No pending pairing for code "${code}". Codes expire after 10 minutes — ask the user to DM the bot again to get a fresh one.`,
          },
        ],
        isError: true,
      };
    }
    pendingPairs.delete(code);
    pairedUsers.set(pending.userId, {
      userId: pending.userId,
      name: pending.name,
      addedAt: Date.now(),
    });
    await saveAccess();
    // Tell the just-paired user they're approved so they don't have to guess.
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
  }

  if (name === "revoke_access") {
    const userIdStr = String((args as { user_id: string }).user_id).trim();
    const userId = Number(userIdStr);
    if (!Number.isFinite(userId)) {
      return {
        content: [{ type: "text", text: `user_id must be numeric, got "${userIdStr}"` }],
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
  }

  if (name === "list_access") {
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
  }

  throw new Error(`unknown tool: ${name}`);
});

// -----------------------------------------------------------------------------
// Telegram inbound → CC channel notification
// -----------------------------------------------------------------------------

/**
 * Pull a Telegram-hosted file down to ~/.cache/cookiedclaw/inbox/. CC's
 * Read tool then has a normal local path it can vision-process (for
 * images) or read text from (for everything else). Filenames are prefixed
 * with the message_id so a chatty user sending many files doesn't collide.
 */
async function downloadTelegramFile(
  fileId: string,
  filename: string,
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("getFile returned no file_path");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download ${url}: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Sanitize filename — Telegram lets users name files arbitrarily and we
  // don't want to be on the wrong side of any path-traversal cleverness.
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const target = resolve(inboxDir, `${Date.now()}_${safe}`);
  await Bun.write(target, bytes);
  return target;
}

/**
 * Shared post-allowlist forwarding: set active chat, push a channel
 * notification to CC. Text-only and attachment cases differ only in
 * whether `attachmentPath` is set.
 *
 * `messageId` is the inbound message's Telegram id — surfaced to CC via
 * meta so the `react` tool can target it (you can't react to a message
 * without knowing its id).
 */
async function forwardToCC(
  chatId: string,
  senderId: string,
  senderLabel: string,
  messageId: number,
  content: string,
  attachmentPath?: string,
): Promise<void> {
  activeChatId = chatId;
  chats.set(chatId, { events: [] });
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
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  } catch (err) {
    console.error(
      `[telegram] failed to push notification: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * First gate any inbound message goes through. If sender isn't on the
 * allowlist, issue/refresh a pair code and stop. Returns `true` when the
 * caller should proceed with normal forwarding.
 */
async function gateInbound(ctx: {
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  chat: { id: number };
}): Promise<{ ok: true; senderId: string; senderLabel: string } | { ok: false }> {
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

bot.on("message:text", async (ctx) => {
  const gated = await gateInbound(ctx);
  if (!gated.ok) return;
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

// -----------------------------------------------------------------------------
// Permission relay: Telegram inline buttons for tool-approval prompts
// -----------------------------------------------------------------------------

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

/**
 * Maps an open permission request to the Telegram message we sent (so we
 * can edit it after the verdict, removing buttons and showing the outcome).
 * Entries leak across long sessions but each is tiny; cleared on verdict
 * or on the rare "tap stale button after CC moved on" path.
 */
const pendingPermissions = new Map<
  string,
  { chatId: number; messageId: number }
>();

function formatPermissionPrompt(p: {
  tool_name: string;
  description: string;
  input_preview: string;
}): string {
  const preview = p.input_preview
    ? `\n\n\`\`\`\n${clamp(p.input_preview, 200)}\n\`\`\``
    : "";
  return `🔒 Claude wants to run **${p.tool_name}**\n\n${p.description}${preview}`;
}

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!activeChatId) {
    dlog(
      `permission request with no active chat (tool=${params.tool_name}, id=${params.request_id})`,
    );
    return;
  }
  const chatId = Number(activeChatId);
  const kb = new InlineKeyboard()
    .text("✓ Allow", `perm_allow:${params.request_id}`)
    .text("✗ Deny", `perm_deny:${params.request_id}`);
  try {
    const sent = await bot.api.sendMessage(
      chatId,
      toTelegramMd(formatPermissionPrompt(params)),
      { parse_mode: "MarkdownV2", reply_markup: kb },
    );
    pendingPermissions.set(params.request_id, {
      chatId,
      messageId: sent.message_id,
    });
    dlog(`permission prompt sent: id=${params.request_id} tool=${params.tool_name}`);
  } catch (err) {
    console.error(
      `[telegram] permission relay send failed: ${err instanceof Error ? err.message : err}`,
    );
  }
});

bot.callbackQuery(/^perm_(allow|deny):([a-km-z]{5})$/, async (ctx) => {
  // Gate by allowlist — anyone who can tap a button in our chat could
  // approve tool use otherwise, which would let an unauthorized viewer
  // (forwarded message, accidental share) compromise the session.
  if (!ctx.from || !isAllowed(ctx.from.id)) {
    await ctx.answerCallbackQuery({
      text: "Access denied — your account isn't paired.",
      show_alert: true,
    });
    return;
  }
  const verdict = ctx.match[1] as "allow" | "deny";
  const requestId = ctx.match[2]!;

  try {
    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: requestId, behavior: verdict },
    });
  } catch (err) {
    console.error(
      `[telegram] permission verdict notification failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Drop buttons and show the outcome inline so the chat is self-explanatory.
  const senderName = senderDisplayName(ctx.from);
  const verdictLine =
    verdict === "allow"
      ? `✓ Allowed by ${senderName}`
      : `✗ Denied by ${senderName}`;
  try {
    await ctx.editMessageText(toTelegramMd(verdictLine), {
      parse_mode: "MarkdownV2",
    });
  } catch {
    // best-effort — message might be too old to edit, that's fine
  }

  pendingPermissions.delete(requestId);
  await ctx.answerCallbackQuery({
    text: verdict === "allow" ? "Approved" : "Denied",
  });
  dlog(`permission verdict: id=${requestId} ${verdict} by ${ctx.from.id}`);
});

bot.catch((err) => {
  console.error(`[telegram] grammy error: ${err.message}`);
});

// -----------------------------------------------------------------------------
// Localhost progress endpoint (called by hooks/tool-progress.ts)
// -----------------------------------------------------------------------------

type ProgressPayload = {
  phase: "pre" | "post";
  tool_name: string;
  tool_use_id: string;
  tool_input?: unknown;
  duration_ms?: number;
  is_error?: boolean;
  error_text?: string;
};

async function handleProgress(p: ProgressPayload): Promise<void> {
  dlog(
    `progress in: phase=${p.phase} tool=${p.tool_name} id=${p.tool_use_id} activeChat=${activeChatId ?? "none"}`,
  );
  if (isReplyTool(p.tool_name)) {
    dlog(`  -> skipped (reply tool)`);
    return;
  }
  if (!activeChatId) {
    dlog(`  -> skipped (no active chat)`);
    return;
  }
  const chatId = activeChatId;
  const state = chats.get(chatId) ?? { events: [] };
  chats.set(chatId, state);

  if (p.phase === "pre") {
    state.events.push({
      toolUseId: p.tool_use_id,
      toolName: p.tool_name,
      inputSummary: summarizeToolInput(p.tool_name, p.tool_input),
      status: "running",
    });
  } else {
    const ev = state.events.find((e) => e.toolUseId === p.tool_use_id);
    if (ev) {
      ev.status = p.is_error ? "error" : "done";
      ev.durationMs = p.duration_ms;
      if (p.error_text) ev.errorText = p.error_text;
    } else {
      // post without a matching pre — shouldn't happen, but be defensive
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

  await queueEdit(chatId, () => pushProgress(chatId));
}

// IPC dir: hook + server have to agree. We deliberately DON'T use
// CLAUDE_PLUGIN_DATA here — the channel server's process inherits
// whatever env CC chose for *MCP servers*, while hooks get the env CC
// chose for *hook commands*, and these aren't guaranteed equal. Fixing
// the path to ~/.cache/cookiedclaw sidesteps the mismatch entirely and
// makes the file easy to inspect for debugging (`cat ~/.cache/cookiedclaw/progress.port`).
const dataDir = resolve(process.env.HOME ?? "/tmp", ".cache", "cookiedclaw");
mkdirSync(dataDir, { recursive: true });
const portFile = resolve(dataDir, "progress.port");
const debugLog = resolve(dataDir, "progress.log");
accessFile = resolve(dataDir, "access.json");
await loadAccess();

const inboxDir = resolve(dataDir, "inbox");
mkdirSync(inboxDir, { recursive: true });

function dlog(line: string): void {
  // Append-only diagnostic log shared with the hook script. Lets us see
  // what's happening without depending on CC's debug-log toggle.
  appendFile(
    debugLog,
    `[${new Date().toISOString()}] [server] ${line}\n`,
    () => {},
  );
}

// Try a small range of ports so two channels on the same machine don't fight.
const PROGRESS_PORT_BASE = 47291;
let progressPort: number | undefined;
for (let i = 0; i < 100; i++) {
  const port = PROGRESS_PORT_BASE + i;
  try {
    Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (req.method !== "POST") return new Response("method", { status: 405 });
        try {
          const body = (await req.json()) as ProgressPayload;
          await handleProgress(body);
          return new Response("ok");
        } catch (err) {
          console.error(
            `[telegram] /progress error: ${err instanceof Error ? err.message : err}`,
          );
          return new Response("error", { status: 500 });
        }
      },
    });
    progressPort = port;
    break;
  } catch (err) {
    // Bun's "port in use" error is a stringy "Failed to start server. Is
    // port N in use?" — no EADDRINUSE token in the message. Sniff for any
    // hint of port-in-use and retry; otherwise break out with the real cause.
    const msg = err instanceof Error ? err.message : String(err);
    const portTaken =
      /EADDRINUSE/i.test(msg) ||
      /in use/i.test(msg) ||
      /address already in use/i.test(msg);
    if (!portTaken) {
      console.error(`[telegram] failed to bind progress port ${port}: ${msg}`);
      break;
    }
  }
}

if (progressPort !== undefined) {
  await Bun.write(portFile, String(progressPort));
  console.error(
    `[telegram] progress endpoint http://127.0.0.1:${progressPort}/ (port written to ${portFile})`,
  );
  dlog(`server up on :${progressPort}, port file ${portFile}`);
} else {
  console.error(
    `[telegram] couldn't bind any progress port — tool log will be missing in chat`,
  );
  dlog(`server failed to bind any port`);
}

// -----------------------------------------------------------------------------
// CC skill / command discovery → Telegram bot menu
// -----------------------------------------------------------------------------

type DiscoveredCommand = { command: string; description: string };

/**
 * Extract `description` from a SKILL.md / command.md YAML frontmatter
 * block. gray-matter handles the awkward cases (multi-line strings,
 * quoted/unquoted, special chars, etc.) that our hand-rolled regex
 * wouldn't.
 */
function parseFrontmatterDescription(raw: string): string | undefined {
  let parsed: { data: Record<string, unknown> };
  try {
    parsed = matter(raw);
  } catch {
    return undefined;
  }
  const desc = parsed.data?.description;
  return typeof desc === "string" && desc.trim() ? desc.trim() : undefined;
}

/**
 * Telegram bot commands must match `[a-z0-9_]{1,32}`. Skills can have
 * hyphens; plugin namespaces use `:`. Squash both to underscores and
 * drop anything else; truncate to 32 chars.
 */
function normalizeCommandName(raw: string): string | undefined {
  // Slice FIRST, then trim trailing underscores — otherwise truncation in
  // the middle of a word leaves names like `/superpowers_verification_`.
  const norm = raw
    .toLowerCase()
    .replace(/[-:]/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 32)
    .replace(/^_+|_+$/g, "");
  return norm || undefined;
}

/**
 * Scan `<root>/skills/*\/SKILL.md` and `<root>/commands/*.md`, parse each
 * for a description, and add to `out` keyed by Telegram-normalized name.
 * `namespace` (plugin name) prefixes the command if set.
 */
async function readSkillsAt(
  root: string,
  namespace: string | undefined,
  out: Map<string, DiscoveredCommand>,
): Promise<void> {
  const skillsDir = resolve(root, "skills");
  if (existsSync(skillsDir)) {
    const glob = new Bun.Glob("*/SKILL.md");
    for await (const rel of glob.scan({ cwd: skillsDir })) {
      const name = rel.split("/")[0];
      if (!name) continue;
      let raw: string;
      try {
        raw = await Bun.file(resolve(skillsDir, rel)).text();
      } catch {
        continue;
      }
      const description = parseFrontmatterDescription(raw);
      if (!description) continue;
      const cmd = normalizeCommandName(
        namespace ? `${namespace}_${name}` : name,
      );
      if (!cmd) continue;
      out.set(cmd, {
        command: cmd,
        description: description.slice(0, TELEGRAM_DESC_LIMIT),
      });
    }
  }

  const commandsDir = resolve(root, "commands");
  if (existsSync(commandsDir)) {
    const glob = new Bun.Glob("*.md");
    for await (const rel of glob.scan({ cwd: commandsDir })) {
      const name = rel.replace(/\.md$/i, "");
      if (!name) continue;
      let raw: string;
      try {
        raw = await Bun.file(resolve(commandsDir, rel)).text();
      } catch {
        continue;
      }
      const description = parseFrontmatterDescription(raw);
      if (!description) continue;
      const cmd = normalizeCommandName(
        namespace ? `${namespace}_${name}` : name,
      );
      if (!cmd) continue;
      out.set(cmd, {
        command: cmd,
        description: description.slice(0, TELEGRAM_DESC_LIMIT),
      });
    }
  }
}

/** Telegram's documented 100-command cap is aspirational; in practice
 * BOT_COMMANDS_TOO_MUCH fires well below that — there's an undocumented
 * ~4 KB total-payload ceiling. We start optimistic and back off in
 * `publishBotMenu` if Telegram complains. */
const TELEGRAM_MAX_BOT_COMMANDS = 30;
/** Cap descriptions short enough that 30 commands fit under the implicit
 * payload cap. Still informative for the menu UI. */
const TELEGRAM_DESC_LIMIT = 100;

/** Skills/commands matching these are CC-internal noise, not things a
 * user would tap from a phone. Hides the worst clutter. */
const HIDDEN_PATTERNS = [
  /^deprecated/i,
  // CC's plumbing-style skills: code-review, debugging, planning loops, etc.
  // Useful inside CC, useless from Telegram chat where the work happens
  // through normal conversation anyway.
  /^superpowers_/,
];

type InstalledPlugin = {
  id: string;
  installPath: string;
  enabled: boolean;
};

/**
 * Authoritative list of installed + enabled plugins from CC itself.
 * Beats globbing `~/.claude/plugins/cache/*\/*\/*\/` because:
 *  - CC tells us which version is active (cache may hold many)
 *  - Disabled plugins are filtered out
 *  - We get the canonical install path
 *
 * Falls back to an empty list on any failure (CC missing from PATH,
 * stale cache, etc.) — discovery degrades to user/project skills only.
 */
async function listEnabledPlugins(): Promise<InstalledPlugin[]> {
  try {
    const proc = Bun.spawn(["claude", "plugin", "list", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0 || !out.trim()) return [];
    const parsed = JSON.parse(out) as Array<Partial<InstalledPlugin>>;
    return parsed.filter(
      (p): p is InstalledPlugin =>
        typeof p.id === "string" &&
        typeof p.installPath === "string" &&
        p.enabled === true,
    );
  } catch (err) {
    dlog(
      `claude plugin list failed: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

async function discoverCommands(): Promise<DiscoveredCommand[]> {
  const home = process.env.HOME ?? "/";
  const homeClaudeDir = resolve(home, ".claude");
  const out = new Map<string, DiscoveredCommand>();

  // User-level skills/commands (no namespace).
  await readSkillsAt(homeClaudeDir, undefined, out);
  // This project's .claude/ — skills/commands shipped with the repo.
  await readSkillsAt(resolve(projectRoot, ".claude"), undefined, out);

  // Plugins: ask CC directly — it knows which version is active and which
  // are enabled. Plugin id is "<name>@<marketplace>"; namespace = name.
  const plugins = await listEnabledPlugins();
  for (const p of plugins) {
    const namespace = p.id.split("@")[0] ?? p.id;
    try {
      await readSkillsAt(p.installPath, namespace, out);
    } catch (err) {
      dlog(
        `skill scan failed for plugin ${namespace}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Filter, sort, cap.
  return [...out.values()]
    .filter(
      (c) =>
        !HIDDEN_PATTERNS.some((re) => re.test(c.command)) &&
        !HIDDEN_PATTERNS.some((re) => re.test(c.description)),
    )
    .sort((a, b) => a.command.localeCompare(b.command))
    .slice(0, TELEGRAM_MAX_BOT_COMMANDS);
}

async function publishBotMenu(): Promise<void> {
  let cmds: DiscoveredCommand[];
  try {
    cmds = await discoverCommands();
  } catch (err) {
    console.error(
      `[telegram] discovery failed: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  if (cmds.length === 0) {
    console.error(`[telegram] no skills/commands discovered for bot menu`);
    return;
  }

  // Telegram's payload cap isn't documented; back off geometrically on
  // BOT_COMMANDS_TOO_MUCH so we don't have to hand-tune the cap forever.
  let attempt = cmds.slice();
  for (let i = 0; i < 5 && attempt.length > 0; i++) {
    try {
      await bot.api.setMyCommands(attempt);
      console.error(
        `[telegram] published ${attempt.length}/${cmds.length} command(s) to bot menu: ${attempt
          .slice(0, 5)
          .map((c) => `/${c.command}`)
          .join(" ")}${attempt.length > 5 ? " …" : ""}`,
      );
      dlog(`bot menu set with ${attempt.length} commands`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("BOT_COMMANDS_TOO_MUCH") || msg.includes("too long")) {
        const next = Math.max(1, Math.floor(attempt.length * 0.6));
        if (next === attempt.length) break;
        dlog(`menu publish: ${attempt.length} too many, retry with ${next}`);
        attempt = attempt.slice(0, next);
        continue;
      }
      console.error(`[telegram] failed to publish bot commands menu: ${msg}`);
      return;
    }
  }
  console.error(
    `[telegram] gave up publishing bot menu after backoff (had ${cmds.length} candidates)`,
  );
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
console.error("[telegram] mcp connected");

if (hasToken) {
  console.error("[telegram] starting bot polling...");
  void bot.start({
    drop_pending_updates: true,
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

