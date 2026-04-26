import { Bot } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import telegramify from "telegramify-markdown";
import { loadSkills, type Skill } from "../skills/loader.ts";
import { createBot, type TelegramOptions } from "../bot/telegram.ts";
import { resolveEmbed } from "../bot/embed-utils.ts";
import { respond } from "../agent/loop.ts";
import { createBotRuntime, type BotRuntime } from "../runtime/index.ts";
import { getRegistry } from "../runtime/registry.ts";

type RunningBot = {
  bot: Bot;
  runtime: BotRuntime;
  handle: RunnerHandle;
};

export type TriggerAgentResult = {
  ok: boolean;
  reply?: string;
  /** Embed sources (paths/URLs) the target produced — passed back so the
   * calling agent can re-embed them in its own reply. */
  embeds?: string[];
  error?: string;
};

export class Orchestrator {
  private running = new Map<number, RunningBot>();
  private skills: Skill[];

  constructor(skills: Skill[]) {
    this.skills = skills;
  }

  has(botId: number): boolean {
    return this.running.has(botId);
  }

  list(): number[] {
    return [...this.running.keys()];
  }

  getRuntime(botId: number): BotRuntime | undefined {
    return this.running.get(botId)?.runtime;
  }

  /**
   * Re-scan all skill roots and update the shared skills array in place.
   * Runtimes hold the same array reference, so updates propagate immediately
   * to every running bot (next turn picks up the new list).
   */
  async reloadSkills(): Promise<{ count: number; names: string[] }> {
    const fresh = await loadSkills();
    this.skills.splice(0, this.skills.length, ...fresh);
    return { count: fresh.length, names: fresh.map((s) => s.name) };
  }

  /**
   * Deliver a text message + optional embeds to a Telegram chat via the
   * given bot. Used by `triggerAgent` for both notify (target's chat) and
   * relay (caller's chat).
   */
  private async deliverToChat(
    bot: Bot,
    chatId: number,
    text: string,
    embedSources: string[],
  ): Promise<void> {
    const display = text || (embedSources.length > 0 ? "✓" : "(no reply)");
    const formatted = telegramify(display, "escape");
    try {
      await bot.api.sendMessage(chatId, formatted, {
        parse_mode: "MarkdownV2",
      });
    } catch {
      await bot.api.sendMessage(chatId, display);
    }
    for (const source of embedSources) {
      try {
        const { file, isImageBytes } = await resolveEmbed(source);
        if (isImageBytes) {
          await bot.api.sendPhoto(chatId, file);
        } else {
          await bot.api.sendDocument(chatId, file);
        }
      } catch (err) {
        console.error(`[trigger] embed dispatch failed:`, err);
      }
    }
  }

  /**
   * Three distinct flows:
   *
   * - **delegate** (`mode: "delegate"`, default): runs the target's full
   *   agent loop with `prompt` as a synthetic user message from
   *   `fromBotId`. Returns reply + embed sources to the caller. No chat
   *   is touched — pure RPC.
   *
   * - **notify** (`mode: "notify"`): bypasses the target's LLM entirely.
   *   `prompt` is the LITERAL message text delivered via `bot.api.sendMessage`
   *   in the target's chat; `options.embeds` are dispatched as attachments.
   *   A synthetic assistant message is persisted in the target's chat
   *   history so the target's agent has a record of the relay later.
   *
   * - **relay** (`mode: "relay"`): runs the target's full agent loop (like
   *   delegate), then delivers the result to the **caller's** chat via the
   *   caller's bot — output reaches the original requester directly, with
   *   the target's voice, no Manager re-narration. Requires
   *   `options.callerChatId`.
   */
  async triggerAgent(
    fromBotId: number,
    targetBotId: number,
    chatId: number,
    prompt: string,
    abortSignal?: AbortSignal,
    options: {
      mode?: "delegate" | "notify" | "relay";
      embeds?: string[];
      callerChatId?: number;
    } = {},
  ): Promise<TriggerAgentResult> {
    const target = this.running.get(targetBotId);
    if (!target) return { ok: false, error: "agent not running" };

    const registry = await getRegistry();
    let fromName = `bot_${fromBotId}`;
    let fromUsername: string | undefined;
    if (registry.managerBotId === fromBotId) {
      fromName = "Manager";
      fromUsername = registry.managerUsername;
    } else {
      const a = registry.agents.find((x) => x.botId === fromBotId);
      if (a) {
        fromName = a.name;
        fromUsername = a.username;
      }
    }

    const mode = options.mode ?? "delegate";
    try {
      // ─── notify: literal text → target's chat, no LLM ──────────────
      if (mode === "notify") {
        const embedSources = options.embeds ?? [];
        await this.deliverToChat(target.bot, chatId, prompt, embedSources);
        // Persist a synthetic assistant message in the target's chat
        // history so the target agent later has context for what was sent.
        const noteSource = fromUsername ? `@${fromUsername}` : fromName;
        const persistedText = `[relayed via ${noteSource}] ${prompt}`;
        try {
          await target.runtime.chatStore.appendMessage(
            { chatId },
            {
              ts: Date.now(),
              message: { role: "assistant", content: persistedText },
            },
          );
          await target.runtime.sessionStore.updateLastActive({ chatId });
        } catch (err) {
          console.warn(`[trigger] persist relay note failed:`, err);
        }
        return { ok: true, reply: prompt, embeds: embedSources };
      }

      // ─── delegate / relay: run the target's full agent loop ───────
      const { reply, embeds } = await respond({
        key: { chatId },
        sender: { id: fromBotId, name: fromName, username: fromUsername },
        userText: prompt,
        runtime: target.runtime,
        abortSignal,
      });
      const embedSources = embeds.map((e) => e.source);

      // ─── relay: deliver the target's output to the caller's chat ──
      if (mode === "relay") {
        if (!options.callerChatId) {
          return {
            ok: false,
            error: "relay mode requires callerChatId",
          };
        }
        const caller = this.running.get(fromBotId);
        if (!caller) {
          return {
            ok: false,
            error: `caller bot ${fromBotId} is not running`,
          };
        }
        await this.deliverToChat(
          caller.bot,
          options.callerChatId,
          reply,
          embedSources,
        );
      }

      return { ok: true, reply, embeds: embedSources };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Create the runtime + bot for a given token, register commands, and start polling
   * in the background. Resolves once `bot.start()` has reported the bot is online.
   */
  async startBot(
    token: string,
    botId: number,
    options: TelegramOptions = {},
  ): Promise<RunningBot> {
    if (this.running.has(botId)) {
      throw new Error(`Bot ${botId} is already running`);
    }
    const runtime = createBotRuntime(botId, this.skills);
    await runtime.mcp.load();

    const triggerAgent: TelegramOptions["triggerAgent"] = (
      target,
      chat,
      prompt,
      abort,
      opts,
    ) => this.triggerAgent(botId, target, chat, prompt, abort, opts);
    const reloadSkills: TelegramOptions["reloadSkills"] = () =>
      this.reloadSkills();
    const bot = createBot(token, runtime, {
      ...options,
      triggerAgent,
      reloadSkills,
    });

    // Use @grammyjs/runner so updates are processed concurrently. Without
    // this, /stop and other commands queue behind a long-running agent turn
    // and never reach the handler until the previous one finishes.
    await bot.init();
    const handle = run(bot, {
      runner: {
        fetch: {
          // Telegram excludes some update types from getUpdates by default —
          // notably `managed_bot` (new in Bot API 9.6), without which our
          // manager wouldn't react to spawned-bot creation. Enumerate every
          // type we touch.
          allowed_updates: [
            "message",
            "edited_message",
            "channel_post",
            "edited_channel_post",
            "callback_query",
            "inline_query",
            "chosen_inline_result",
            "my_chat_member",
            "chat_member",
            "managed_bot",
          ],
        },
      },
    });

    const entry: RunningBot = { bot, runtime, handle };
    this.running.set(botId, entry);
    return entry;
  }

  async stopBot(botId: number): Promise<void> {
    const entry = this.running.get(botId);
    if (!entry) return;
    this.running.delete(botId);
    await entry.handle.stop();
    await entry.runtime.mcp.close();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stopBot(id)));
  }
}
