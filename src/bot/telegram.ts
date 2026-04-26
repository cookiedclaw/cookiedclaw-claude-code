import { basename, resolve } from "node:path";
import { Bot, type Context, InlineKeyboard } from "grammy";
import { resolveEmbed } from "./embed-utils.ts";
import type { MessageEntity } from "grammy/types";
import telegramify from "telegramify-markdown";
import {
  respond,
  type Attachment,
  type ToolEvent,
} from "../agent/loop.ts";
import type { BotRuntime } from "../runtime/index.ts";
import { userSandboxPath } from "../runtime/paths.ts";
import { setRegistryOwner } from "../runtime/registry.ts";
import type { ToolEmojis } from "../store/config.ts";
import type { SessionKey } from "../store/types.ts";
import { registerCommands, sessionKeyFromCtx } from "./commands.ts";

const sessionRunKey = (key: SessionKey) => String(key.chatId);

const BOOTSTRAP = `🎉 You're now the owner of this bot.

To get started:

1. Set an API key for at least one provider:
\`/setkey gateway <key>\`
\`/setkey anthropic <key>\`
\`/setkey openai <key>\`
\`/setkey openrouter <key>\`

2. Enable long-term memory with Supermemory (this is how the bot remembers anything across conversations):
\`/setmemorykey <your supermemory key>\`

3. (Optional) Enable web search with Tavily:
\`/settavilykey <your tavily key>\`

Then type any message to chat. Use \`/help\` to see all commands.`;

export type TriggerAgent = (
  targetBotId: number,
  chatId: number,
  prompt: string,
  abortSignal?: AbortSignal,
  options?: {
    mode?: "delegate" | "notify" | "relay";
    embeds?: string[];
    callerChatId?: number;
  },
) => Promise<{
  ok: boolean;
  reply?: string;
  embeds?: string[];
  error?: string;
}>;

export type ReloadSkills = () => Promise<{ count: number; names: string[] }>;

export type TelegramOptions = {
  /** True for the manager bot. First-message claims registry ownership. */
  claimsRegistryOwnership?: boolean;
  /** Extra owner-only help text appended to /help (e.g. manager commands). */
  ownerExtraHelp?: string;
  /** Hook to register additional handlers on the bot before message:text. */
  configureExtra?: (bot: Bot, runtime: BotRuntime) => void;
  /** Cross-agent trigger capability (passed by the orchestrator). */
  triggerAgent?: TriggerAgent;
  /** Re-scan skill roots and update the shared skills array in place. */
  reloadSkills?: ReloadSkills;
};

export function createBot(
  token: string,
  runtime: BotRuntime,
  options: TelegramOptions = {},
): Bot {
  const bot = new Bot(token);
  // One active controller per (chat_id, thread_id). New messages cancel the
  // prior in-flight run; /stop also targets the current session.
  const activeRuns = new Map<string, AbortController>();
  // Retry payloads keyed by short id (callback_data limit is 64 bytes).
  // Persisted to disk so the Retry button keeps working across bot
  // restarts. Image bytes are stored on disk anyway (uploads/<path>), so
  // we serialize just the path + metadata and rehydrate the bytes on click.
  const retriesFile = resolve(runtime.paths.dataDir, "retries.json");
  type StoredRetry = {
    userText: string;
    attachments?: Array<{
      kind: "image" | "file";
      path: string;
      mediaType?: string;
      name?: string;
    }>;
    createdAt: number;
  };
  const retryStore = new Map<string, StoredRetry>();
  const RETRY_TTL_MS = 60 * 60 * 1000;
  const newRetryId = () => Math.random().toString(36).slice(2, 10);
  const sweepRetries = (): boolean => {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of retryStore) {
      if (now - p.createdAt > RETRY_TTL_MS) {
        retryStore.delete(id);
        changed = true;
      }
    }
    return changed;
  };
  const persistRetries = async (): Promise<void> => {
    try {
      await Bun.write(
        retriesFile,
        JSON.stringify(Object.fromEntries(retryStore)),
      );
    } catch (err) {
      console.error("[bot] persist retries failed:", err);
    }
  };
  // Load any retries left over from the previous boot (sweep expired).
  void (async () => {
    try {
      const file = Bun.file(retriesFile);
      if (!(await file.exists())) return;
      const data = (await file.json()) as Record<string, StoredRetry>;
      const now = Date.now();
      for (const [id, r] of Object.entries(data)) {
        if (r && typeof r.userText === "string" && now - r.createdAt <= RETRY_TTL_MS) {
          retryStore.set(id, r);
        }
      }
    } catch (err) {
      console.error("[bot] load retries failed:", err);
    }
  })();

  bot.use(async (ctx, next) => {
    // Updates without a user-level `from` field (managed_bot creation,
    // system events) bypass owner-checks and continue down the chain.
    if (!ctx.from) {
      await next();
      return;
    }
    const ownerId = await runtime.getOwnerId();

    if (ownerId === undefined) {
      if (options.claimsRegistryOwnership) {
        await setRegistryOwner(ctx.from.id);
        await ctx.reply(BOOTSTRAP, { parse_mode: "Markdown" });
        return;
      }
      await ctx.reply("This bot is not yet active.");
      return;
    }

    if (ctx.from.id === ownerId) {
      await next();
      return;
    }

    if (await runtime.configStore.isApproved(ctx.from.id)) {
      await next();
      return;
    }

    const code = await runtime.configStore.getOrCreatePendingCode(
      ctx.from.id,
      ctx.from.first_name,
    );
    await ctx.reply(
      `You're not approved to use this bot.\n\nAsk the owner to run:\n\`/approve ${code}\`\n\nThe code expires in 1 hour.`,
      { parse_mode: "Markdown" },
    );
  });

  registerCommands(bot, runtime, {
    ownerExtraHelp: options.ownerExtraHelp,
    reloadSkills: options.reloadSkills,
    isRunning: (key) => !!activeRuns.get(sessionRunKey(key)),
  });
  options.configureExtra?.(bot, runtime);

  /**
   * Download a Telegram file by id, save to the user's sandbox uploads dir,
   * and return the saved path + raw bytes.
   */
  async function downloadAndSave(
    ctx: Context,
    fileId: string,
    preferredName: string,
  ): Promise<{
    sandboxPath: string;
    relativePath: string;
    filename: string;
    data: Uint8Array;
  } | null> {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) return null;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = new Uint8Array(await res.arrayBuffer());

    const filename = basename(preferredName).replace(/[^\w.\-]+/g, "_") || "file";
    const sandboxRoot = userSandboxPath(runtime.botId, ctx.from!.id);
    const sandboxPath = resolve(sandboxRoot, "uploads", filename);
    await Bun.write(sandboxPath, data);
    return {
      sandboxPath,
      relativePath: `uploads/${filename}`,
      filename,
      data,
    };
  }

  /**
   * Run one agent turn for the current message. Handles the typing indicator,
   * progress message, agent call, and final reply. Used by all incoming-message
   * handlers (text, document, photo).
   */
  async function runAgentTurn(
    ctx: Context,
    args: { userText: string; attachments?: Attachment[] },
  ): Promise<void> {
    if (!(await runtime.configStore.hasAnyKey())) {
      await ctx.reply(
        "No API keys configured. Ask the owner to set one with `/setkey <provider> <key>`.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const key = sessionKeyFromCtx(ctx);
    const chatId = ctx.chat!.id;
    const runId = sessionRunKey(key);

    // A prior message still working in this session? Cancel it.
    activeRuns.get(runId)?.abort();
    const controller = new AbortController();
    activeRuns.set(runId, controller);

    let progressMsgId: number | null = null;
    let lastEditAt = 0;
    let lastEditedText = "";
    let lastEditedEntities: MessageEntity[] = [];
    // Lock for the initial placeholder send so concurrent tool events don't
    // race and create two orphan messages.
    let placeholderPromise: Promise<void> | null = null;
    const emojis = (await runtime.configStore.getConfig()).emojis;

    const renderProgress = async (events: ToolEvent[]) => {
      // Race-safe placeholder send: first caller starts the reply; others wait.
      if (progressMsgId === null) {
        if (!placeholderPromise) {
          const initial = formatToolLog(events, emojis);
          placeholderPromise = (async () => {
            try {
              const msg = await ctx.reply(initial.text, {
                entities:
                  initial.entities.length > 0 ? initial.entities : undefined,
              });
              progressMsgId = msg.message_id;
              lastEditedText = initial.text;
              lastEditedEntities = initial.entities;
              lastEditAt = Date.now();
            } catch (err) {
              console.error("[bot] progress placeholder send failed:", err);
            }
          })();
        }
        await placeholderPromise;
        // Fall through — if our events are newer than what got sent, edit below.
      }
      if (progressMsgId === null) return; // send failed

      const { text, entities } = formatToolLog(events, emojis);
      if (text === lastEditedText) return;
      const now = Date.now();
      if (now - lastEditAt < 1000) return;
      try {
        await bot.api.editMessageText(chatId, progressMsgId, text, {
          entities: entities.length > 0 ? entities : undefined,
        });
        lastEditedText = text;
        lastEditedEntities = entities;
        lastEditAt = now;
      } catch {
        // rate-limit / not-modified — ignore
      }
    };

    // Telegram's typing indicator lasts ~5s. Refresh it while the agent runs.
    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    try {
      const from = ctx.from!;
      const senderName =
        [from.first_name, from.last_name].filter(Boolean).join(" ") ||
        from.username ||
        `user_${from.id}`;
      const { reply: replyText, embeds } = await respond({
        key,
        sender: { id: from.id, name: senderName, username: from.username },
        userText: args.userText,
        attachments: args.attachments,
        runtime,
        abortSignal: controller.signal,
        notifyUser: async (userId, message) => {
          try {
            await bot.api.sendMessage(userId, message);
          } catch (err) {
            console.error("[bot] failed to notify user:", err);
          }
        },
        getBotInfo: async () => {
          const me = (await bot.api.getMe()) as {
            username?: string;
            can_manage_bots?: boolean;
          };
          return {
            username: me.username ?? "",
            canManageBots: me.can_manage_bots ?? false,
          };
        },
        triggerAgent: options.triggerAgent,
        reloadSkills: options.reloadSkills,
        onProgress: renderProgress,
      });

      // Telegram caption limit is 1024 chars; stay slightly under for headroom
      // around MarkdownV2 escapes.
      const CAPTION_MAX = 1000;
      const display = replyText || (embeds.length > 0 ? "" : "(no reply)");

      // Single embed + short reply → send as ONE message with caption, drop
      // the progress placeholder. That's the cleanest UX: attachment + text
      // bubble together, no orphan messages.
      if (embeds.length === 1 && display.length <= CAPTION_MAX) {
        const e = embeds[0]!;
        try {
          const { file, isImageBytes } = await resolveEmbed(e.source);
          const sendAsPhoto = e.kind === "file" ? false : isImageBytes;
          const captionFormatted = display
            ? telegramify(display, "escape")
            : undefined;
          const trySendWithCaption = async (
            useMarkdown: boolean,
            captionText: string | undefined,
          ) => {
            const opts = captionText
              ? useMarkdown
                ? { caption: captionText, parse_mode: "MarkdownV2" as const }
                : { caption: captionText }
              : {};
            if (sendAsPhoto) {
              await bot.api.sendPhoto(chatId, file, opts);
            } else {
              await bot.api.sendDocument(chatId, file, opts);
            }
          };
          try {
            await trySendWithCaption(true, captionFormatted);
          } catch {
            // MarkdownV2 parse failed; fall back to plain caption.
            await trySendWithCaption(false, display || undefined);
          }
          if (progressMsgId !== null) {
            try {
              await bot.api.deleteMessage(chatId, progressMsgId);
            } catch {
              // Already gone or edit-only chat — ignore.
            }
          }
        } catch (err) {
          // Falling back to the multi-message path below.
          console.error("[bot] embed-with-caption failed, falling back:", err);
          await sendReplyAndEmbeds();
        }
      } else {
        await sendReplyAndEmbeds();
      }

      async function sendReplyAndEmbeds() {
        const formatted = telegramify(display, "escape");
        if (progressMsgId !== null) {
          try {
            await bot.api.editMessageText(chatId, progressMsgId, formatted, {
              parse_mode: "MarkdownV2",
            });
          } catch {
            try {
              await bot.api.editMessageText(chatId, progressMsgId, display);
            } catch (fallbackErr) {
              console.error("[bot] plain edit also failed:", fallbackErr);
              await ctx.reply(display);
            }
          }
        } else if (display) {
          try {
            await ctx.reply(formatted, { parse_mode: "MarkdownV2" });
          } catch {
            await ctx.reply(display);
          }
        }

        for (const e of embeds) {
          try {
            const { file, isImageBytes } = await resolveEmbed(e.source);
            const sendAsPhoto = e.kind === "file" ? false : isImageBytes;
            if (sendAsPhoto) {
              await bot.api.sendPhoto(chatId, file);
            } else {
              await bot.api.sendDocument(chatId, file);
            }
          } catch (err) {
            await ctx.reply(
              `Couldn't send \`${e.source}\`: ${err instanceof Error ? err.message : String(err)}`,
              { parse_mode: "Markdown" },
            );
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        const stopLine = "⏹ Stopped.";
        if (progressMsgId !== null) {
          // Append the stop line to the existing tool log instead of replacing
          // it — the user wants to see WHAT got done before /stop fired.
          const merged = lastEditedText
            ? `${lastEditedText}\n${stopLine}`
            : stopLine;
          try {
            await bot.api.editMessageText(chatId, progressMsgId, merged, {
              entities:
                lastEditedEntities.length > 0
                  ? lastEditedEntities
                  : undefined,
            });
          } catch {
            // ignore
          }
        } else {
          await ctx.reply(stopLine);
        }
      } else {
        console.error("[bot] handler error:", err);
        sweepRetries();
        const id = newRetryId();
        retryStore.set(id, {
          userText: args.userText,
          attachments: args.attachments?.map((a) =>
            a.kind === "image"
              ? { kind: "image", path: a.path, mediaType: a.mediaType }
              : {
                  kind: "file",
                  path: a.path,
                  mediaType: a.mediaType,
                  name: a.name,
                },
          ),
          createdAt: Date.now(),
        });
        await persistRetries();
        const errMsg = err instanceof Error ? err.message : String(err);
        const kb = new InlineKeyboard().text("🔄 Retry", `retry:${id}`);
        await ctx.reply(`Error: ${errMsg}`, { reply_markup: kb });
      }
    } finally {
      clearInterval(typingInterval);
      // Only clear our entry if it's still ours (a new message may have replaced it).
      if (activeRuns.get(runId) === controller) activeRuns.delete(runId);
    }
  }

  bot.command("stop", async (ctx) => {
    if (!ctx.from) return;
    const key = sessionKeyFromCtx(ctx);
    const controller = activeRuns.get(sessionRunKey(key));
    if (!controller) {
      await ctx.reply("Nothing running in this chat.");
      return;
    }
    controller.abort();
    // The handler will reply "Stopped" once the abort propagates.
  });

  bot.callbackQuery(/^retry:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const payload = id ? retryStore.get(id) : undefined;
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "This retry expired. Send the message again.",
        show_alert: true,
      });
      return;
    }
    retryStore.delete(id!);
    await persistRetries();
    await ctx.answerCallbackQuery({ text: "Retrying…" });
    // Drop the inline keyboard so the user can't double-click. Errors are
    // ignored — if the original error message is unreachable, that's fine.
    try {
      await ctx.editMessageReplyMarkup({});
    } catch {
      // ignore
    }

    // Rehydrate attachments from the persisted side-table. Image kind needs
    // its bytes loaded back from disk for vision; file kind is path-only.
    const attachments: Attachment[] = [];
    for (const a of payload.attachments ?? []) {
      try {
        if (a.kind === "image") {
          const file = Bun.file(a.path);
          if (!(await file.exists())) continue;
          attachments.push({
            kind: "image",
            data: new Uint8Array(await file.arrayBuffer()),
            path: a.path,
            mediaType: a.mediaType,
          });
        } else {
          attachments.push({
            kind: "file",
            name: a.name ?? "file",
            path: a.path,
            mediaType: a.mediaType,
          });
        }
      } catch (err) {
        console.warn(`[bot] retry: failed to rehydrate ${a.path}`, err);
      }
    }

    await runAgentTurn(ctx, {
      userText: payload.userText,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    await runAgentTurn(ctx, { userText: ctx.message.text });
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const preferredName = doc.file_name ?? `file_${doc.file_unique_id}`;
    const saved = await downloadAndSave(ctx, doc.file_id, preferredName);
    if (!saved) {
      await ctx.reply("Failed to download file.");
      return;
    }
    const sizeKb = Math.round((doc.file_size ?? saved.data.byteLength) / 1024);
    const mime = doc.mime_type ? ` ${doc.mime_type}` : "";
    const caption = ctx.message.caption ?? "";
    const note = `📎 [platform] File \`${saved.filename}\` (${sizeKb} KB${mime}) is already saved at \`${saved.relativePath}\` in your workspace. Use that exact path with \`read\` / \`bash\` / \`send_photo\` — do not search the filesystem for it.`;
    const userText = caption ? `${note}\n\n${caption}` : note;

    const isImage = doc.mime_type?.startsWith("image/");
    const attachments: Attachment[] = isImage
      ? [
          {
            kind: "image",
            data: saved.data,
            path: saved.sandboxPath,
            mediaType: doc.mime_type,
          },
        ]
      : [
          {
            kind: "file",
            name: saved.filename,
            path: saved.sandboxPath,
            mediaType: doc.mime_type,
          },
        ];

    await runAgentTurn(ctx, { userText, attachments });
  });

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    if (!largest) return;
    const filename = `photo_${largest.file_unique_id}.jpg`;
    const saved = await downloadAndSave(ctx, largest.file_id, filename);
    if (!saved) {
      await ctx.reply("Failed to download photo.");
      return;
    }
    const caption = ctx.message.caption ?? "";
    const note = `📷 [platform] Photo is already saved at \`${saved.relativePath}\` in your workspace. Use that exact path with \`read\` / \`bash\` / \`send_photo\` — do not search the filesystem for it.`;
    const userText = caption ? `${note}\n\n${caption}` : note;
    await runAgentTurn(ctx, {
      userText,
      attachments: [
        {
          kind: "image",
          data: saved.data,
          path: saved.sandboxPath,
          mediaType: "image/jpeg",
        },
      ],
    });
  });

  bot.catch((err) => console.error("[bot] runtime error:", err));
  return bot;
}

function formatToolLog(
  events: ToolEvent[],
  emojis?: ToolEmojis,
): { text: string; entities: MessageEntity[] } {
  if (events.length === 0) return { text: "🔧 working…", entities: [] };

  const entities: MessageEntity[] = [];
  const lines: string[] = [];
  let offset = 0;

  for (const e of events) {
    // If custom emojis are set AND in the new {id, char} shape, use them.
    // Otherwise fall back to plain unicode (covers both unconfigured and
    // legacy string-id config from before we added the fallback char).
    const candidate = emojis
      ? e.status === "running"
        ? emojis.running
        : e.status === "error"
          ? emojis.error
          : emojis.done
      : undefined;
    const validEmoji =
      candidate &&
      typeof candidate === "object" &&
      typeof candidate.id === "string" &&
      typeof candidate.char === "string"
        ? candidate
        : undefined;

    const icon =
      validEmoji?.char ??
      (e.status === "running" ? "⏳" : e.status === "error" ? "✗" : "✓");

    if (validEmoji) {
      entities.push({
        type: "custom_emoji",
        offset,
        length: icon.length,
        custom_emoji_id: validEmoji.id,
      });
    }

    const tail =
      e.status === "error" && e.error ? ` — ${truncate(e.error, 80)}` : "";
    const label = e.summary?.trim() || summarizeToolCall(e.name, e.args);
    const result =
      e.status === "done" && e.resultSummary?.trim()
        ? ` → ${e.resultSummary.trim()}`
        : "";
    const line = `${icon} ${label}${result}${tail}`;
    lines.push(line);
    offset += line.length + 1; // +1 for the joining newline
  }

  return { text: lines.join("\n"), entities };
}

function shorten(s: string, max = 60): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1).trimEnd() + "…";
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function humanize(name: string): string {
  if (!name) return "";
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Render a tool call as a one-line summary of what the agent is doing right
 * now (the user sees this in their chat). Built-in tools have explicit
 * templates; unknown / MCP tools fall back to humanized name + first string
 * arg.
 */
function summarizeToolCall(name: string, rawArgs: unknown): string {
  const args = (
    rawArgs && typeof rawArgs === "object" ? rawArgs : {}
  ) as Record<string, unknown>;
  const get = (k: string) => asString(args[k]);

  switch (name) {
    case "bash":
      return `Run: ${shorten(get("command"), 70)}`;
    case "read":
      return `Read ${shorten(get("path"))}`;
    case "write":
      return `Write ${shorten(get("path"))}`;
    case "edit":
      return `Edit ${shorten(get("path"))}`;
    case "fal_search_models": {
      const q = get("query");
      const cat = get("category");
      const ep = get("endpoint_id");
      const tag = [ep, cat, q && `"${q}"`].filter(Boolean).join(" · ");
      return tag ? `Search fal models: ${shorten(tag, 50)}` : "Browse fal models";
    }
    case "fal_run": {
      const ep = get("endpoint_id");
      return ep ? `Run fal: ${shorten(ep, 50)}` : "Run fal endpoint";
    }
    case "fal_upload": {
      const exp = get("expires_in");
      return exp
        ? `Upload to fal.ai (${exp}): ${shorten(get("path"))}`
        : `Upload to fal.ai: ${shorten(get("path"))}`;
    }
    case "generate_image": {
      const sz = get("size");
      const m = get("model");
      const refs = Array.isArray(args.reference_images)
        ? (args.reference_images as unknown[]).length
        : 0;
      const verb = refs > 0 ? `Edit image (${refs} ref${refs === 1 ? "" : "s"})` : "Generate image";
      const tag = [m, sz].filter(Boolean).join(", ");
      return tag
        ? `${verb} (${tag}): "${shorten(get("prompt"), 40)}"`
        : `${verb}: "${shorten(get("prompt"), 50)}"`;
    }
    case "web_search":
      return `Search the web: "${shorten(get("query"), 50)}"`;
    case "web_fetch":
      return `Fetch ${shorten(get("url"))}`;
    case "searchMemories":
      return `Search memory: "${shorten(get("informationToGet") || get("query"), 50)}"`;
    case "addMemory":
      return `Save memory: "${shorten(get("memory") || get("content"), 50)}"`;
    case "documentList":
      return "List memory documents";
    case "documentAdd":
      return "Save document to memory";
    case "documentDelete":
      return "Delete memory document";
    case "memoryForget":
      return "Forget memory";
    case "getProfile":
      return "Read user profile";
    case "loadSkill":
      return `Load skill: ${get("name")}`;
    case "list_models":
      return args.provider
        ? `List models for ${get("provider")}`
        : "List available models";
    case "list_skills_available":
      return "List skills";
    case "list_provider_keys":
      return "Check provider keys";
    case "list_mcp_servers":
      return "List MCP servers";
    case "list_approved_users":
      return "List approved users";
    case "list_pending_users":
      return "List pending users";
    case "list_spawned_agents":
      return "List spawned agents";
    case "list_chats":
      return "List active chats";
    case "get_chat_config":
      return "Show chat config";
    case "set_provider":
      return `Switch provider to ${get("provider")}`;
    case "set_model":
      return `Switch model to ${get("model")}`;
    case "set_system_prompt":
      return "Update system prompt";
    case "clear_system_prompt":
      return "Clear system prompt";
    case "set_default_provider":
      return args.model
        ? `Set default: ${get("provider")} / ${get("model")}`
        : `Set default provider: ${get("provider")}`;
    case "remove_provider_key":
      return `Remove ${get("provider")} key`;
    case "mcp_add_http":
    case "mcp_add_stdio":
      return `Add MCP server: ${get("name")}`;
    case "mcp_remove":
      return `Remove MCP server: ${get("name")}`;
    case "mcp_reload":
      return "Reload MCP servers";
    case "approve_user":
      return "Approve user";
    case "revoke_user":
      return `Revoke user ${get("userId")}`;
    case "spawn_agent":
      return `Create agent: ${get("name")}`;
    case "set_agent_default":
      return `Reconfigure agent: ${get("agent")}`;
    case "share_key_with_agent":
      return `Share ${get("key")} key with ${get("agent")}`;
    case "share_all_keys_with_agent":
      return `Share all keys with ${get("agent")}`;
    case "trigger_agent": {
      const a = get("agent");
      const c = get("chat_id");
      const target = a ? `@${a}` : c ? `chat ${c}` : "self";
      return `Delegate to ${target}: "${shorten(get("prompt"), 40)}"`;
    }
    case "reload_skills":
      return "Rescan skills";
    default: {
      const nice = name.includes("__")
        ? name
            .split("__")
            .map(humanize)
            .filter(Boolean)
            .join(" · ")
        : humanize(name);
      const primary = Object.values(args).find(
        (v) => typeof v === "string" && v.length > 0,
      ) as string | undefined;
      return primary ? `${nice}: ${shorten(primary)}` : nice;
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
