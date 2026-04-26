import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { BotCommand } from "grammy/types";
import { buildContextBreakdown, compactNow } from "../agent/loop.ts";
import {
  fetchAvailableModels,
  modelLabel,
  pickRecommendedModels,
  type ListedModel,
} from "../agent/model-list.ts";
import type { ServerConfig } from "../mcp/store.ts";
import {
  AUX_KEYS,
  AUX_KEY_INFO,
  DEFAULT_MODELS,
  PROVIDERS,
  isProvider,
  type AuxKey,
  type Provider,
} from "../store/config.ts";
import type { BotRuntime } from "../runtime/index.ts";
import type { SessionKey } from "../store/types.ts";
import { ownerOnly, reply, sessionKeyFromCtx } from "./helpers.ts";

export { sessionKeyFromCtx };

export const USER_COMMANDS: BotCommand[] = [
  { command: "start", description: "Welcome / claim ownership" },
  { command: "help", description: "Show all commands" },
  { command: "stop", description: "Stop the currently running agent" },
  { command: "keys", description: "List configured providers" },
  { command: "provider", description: "Show or set provider for this chat" },
  { command: "model", description: "Show or set model for this chat" },
  { command: "system", description: "Show, set, or clear system prompt for this chat" },
  { command: "clear", description: "Wipe history for this chat" },
  { command: "config", description: "Show effective config for this chat" },
  { command: "reload", description: "Re-scan skill directories" },
  { command: "compact", description: "Summarize chat history into one entry" },
  { command: "context", description: "Show token breakdown for this chat" },
];

/** Parametric `/setXkey` + `/removeXkey` command pairs, one per aux service. */
const AUX_KEY_COMMANDS: BotCommand[] = AUX_KEYS.flatMap((name) => [
  {
    command: `set${name}key`,
    description: `(owner) Set ${AUX_KEY_INFO[name].label} key`,
  },
  {
    command: `remove${name}key`,
    description: `(owner) Remove ${AUX_KEY_INFO[name].label} key`,
  },
]);

export const OWNER_COMMANDS: BotCommand[] = [
  ...USER_COMMANDS,
  { command: "setkey", description: "(owner) Set an API key" },
  { command: "removekey", description: "(owner) Remove an API key" },
  ...AUX_KEY_COMMANDS,
  { command: "emoji", description: "(owner) Set custom tool-call emojis" },
  { command: "setdefault", description: "(owner) Set default provider/model" },
  { command: "mcp", description: "(owner) Manage MCP servers" },
  { command: "users", description: "(owner) List approved and pending users" },
  { command: "approve", description: "(owner) Approve a pending user" },
  { command: "revoke", description: "(owner) Revoke a user's access" },
];

const buildHelp = (provider_list: string) => ({
  user: `*Commands*

Per-chat
\`/provider [name]\` — show or set provider for this chat
\`/model [id]\` — show or set model for this chat
\`/system [text]\` — show, set, or clear the system prompt for this chat
\`/clear\` — wipe history for this chat
\`/config\` — show this chat's effective config
\`/keys\` — show which providers have keys set
\`/reload\` — re-scan skill directories (after \`npx skills add ...\`)
\`/compact [extra instructions]\` — summarize this chat's history into a single recap entry (auto-runs near the context limit; use this to trigger it manually, e.g. \`/compact focus on decisions only\`)
\`/context\` — show token breakdown for this chat (system, tools, history, compaction thresholds)

Providers: ${provider_list}`,
  ownerExtra: `

*Owner only*

Setup
\`/setkey <provider> <key>\` — set API key (your message is auto-deleted)
\`/removekey <provider>\` — remove an API key
${AUX_KEYS.map(
  (k) =>
    `\`/set${k}key <key>\` — set ${AUX_KEY_INFO[k].label} key (auto-deleted; enables ${AUX_KEY_INFO[k].describes})\n\`/remove${k}key\` — disable ${AUX_KEY_INFO[k].label}`,
).join("\n")}
\`/emoji <running> <done> <error>\` — set custom tool-call emojis (use 3 animated emojis from a premium pack); \`/emoji clear\` to revert
\`/setdefault <provider> [model]\` — set the global default

MCP servers
\`/mcp\` — list configured MCP servers
\`/mcp add http <name> <url> [bearer]\` — add an HTTP MCP server
\`/mcp add stdio <name> <command> [args...]\` — add a stdio MCP server
\`/mcp remove <name>\` — remove a server
\`/mcp reload\` — reconnect all servers

Users
\`/users\` — list approved and pending users
\`/approve <code>\` — approve a pending user
\`/revoke <userId>\` — revoke a user's access`,
});

/**
 * In-memory TTL cache of fetched-and-filtered model lists per provider.
 * Picker buttons reference models by index into the cached list, so the
 * cache also acts as the indirection that lets us fit long IDs inside
 * Telegram's 64-byte callback_data limit. Entries refresh on demand
 * after `MODEL_CACHE_TTL_MS`.
 */
type CachedModels = { models: ListedModel[]; fetchedAt: number };
const modelCache = new Map<Provider, CachedModels>();
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

async function getPickerModels(
  provider: Provider,
  runtime: BotRuntime,
  signal?: AbortSignal,
): Promise<{ ok: true; models: ListedModel[] } | { ok: false; error: string }> {
  const cached = modelCache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    return { ok: true, models: cached.models };
  }
  const cfg = await runtime.configStore.getConfig();
  const result = await fetchAvailableModels(provider, cfg, signal);
  if (!result.ok) return { ok: false, error: result.error };
  const filtered = pickRecommendedModels(result.models);
  modelCache.set(provider, { models: filtered, fetchedAt: Date.now() });
  return { ok: true, models: filtered };
}

/**
 * Inline keyboard for the `/model` (scope `mp`) and `/setdefault` (scope
 * `dp`) pickers. First row is a provider switcher; the rest are one
 * button per model from the cached recommended list, with ✓ on the
 * active selection. Buttons reference models by index into the cache —
 * tap handlers resolve `<scope>:set:<provider>:<idx>` against the same
 * cache.
 */
function buildPickerKeyboard(
  scope: "mp" | "dp",
  displayProvider: Provider,
  currentProvider: Provider,
  currentModel: string,
  models: ListedModel[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PROVIDERS) {
    const label = p === displayProvider ? `• ${p}` : p;
    kb.text(label, `${scope}:view:${p}`);
  }
  kb.row();
  for (let i = 0; i < models.length; i++) {
    const m = models[i]!;
    const active =
      currentProvider === displayProvider && currentModel === m.id;
    kb.text(
      `${active ? "✓ " : ""}${modelLabel(m)}`,
      `${scope}:set:${displayProvider}:${i}`,
    ).row();
  }
  kb.text("🔄 Refresh", `${scope}:refresh:${displayProvider}`);
  return kb;
}

function buildEmptyPickerKeyboard(
  scope: "mp" | "dp",
  displayProvider: Provider,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PROVIDERS) {
    const label = p === displayProvider ? `• ${p}` : p;
    kb.text(label, `${scope}:view:${p}`);
  }
  kb.row();
  kb.text("🔄 Retry", `${scope}:refresh:${displayProvider}`);
  return kb;
}

function buildChatPickerText(
  provider: Provider,
  model: string,
  source: "chat" | "default",
): string {
  return `Model: \`${model}\` _(${source})_\nProvider: \`${provider}\`\n\nPick from below or type \`/model <id>\` for a custom one.`;
}

function buildDefaultPickerText(provider: Provider, model: string): string {
  return `Default: \`${provider}\` / \`${model}\`\n\nPick from below or type \`/setdefault <provider> <id>\` for a custom one.`;
}

export function registerCommands(
  bot: Bot,
  runtime: BotRuntime,
  options: {
    ownerExtraHelp?: string;
    reloadSkills?: () => Promise<{ count: number; names: string[] }>;
    isRunning?: (key: SessionKey) => boolean;
  } = {},
) {
  const { configStore, mcpStore, mcp, sessionStore, chatStore } = runtime;
  const help = buildHelp(PROVIDERS.join(", "));
  const isOwner = (ctx: Context) => ownerOnly(ctx, runtime);

  bot.command("start", async (ctx) => {
    const has = await configStore.hasAnyKey();
    await reply(
      ctx,
      `cookiedclaw is ready.\n\n${
        has
          ? "Type a message to chat. Use /help for commands."
          : "Set an API key to begin: `/setkey <provider> <key>`"
      }`,
    );
  });

  bot.command("help", async (ctx) => {
    const ownerId = await runtime.getOwnerId();
    const isOwner = ctx.from?.id === ownerId;
    let body = help.user;
    if (isOwner) body += help.ownerExtra;
    if (isOwner && options.ownerExtraHelp) body += options.ownerExtraHelp;
    await reply(ctx, body);
  });

  bot.command("keys", async (ctx) => {
    const cfg = await configStore.getConfig();
    const lines = PROVIDERS.map((p) => `${cfg.keys[p] ? "✓" : "✗"} ${p}`);
    await reply(ctx, `*Providers*\n${lines.join("\n")}`);
  });

  bot.command("context", async (ctx) => {
    if (!ctx.from) return;
    const key = sessionKeyFromCtx(ctx);
    await ctx.replyWithChatAction("typing");
    const b = await buildContextBreakdown({
      key,
      userId: ctx.from.id,
      runtime,
    });
    const fmt = (n: number) => n.toLocaleString("en-US");
    const pct = ((b.totalTokens / b.contextWindow) * 100).toFixed(1);
    const compactPct = ((b.compactAt / b.contextWindow) * 100).toFixed(0);

    const bar = (() => {
      const total = 20;
      const filled = Math.min(
        total,
        Math.round((b.totalTokens / b.contextWindow) * total),
      );
      return "█".repeat(filled) + "░".repeat(total - filled);
    })();

    const busy = options.isRunning?.(key) === true;
    const body = [
      `*Model:* \`${b.model}\` (${b.provider})`,
      `*Window:* ${fmt(b.contextWindow)} tokens${busy ? "  ·  ⚙️ agent running" : ""}`,
      ``,
      `*Usage*`,
      `${bar} ${pct}%`,
      `• System prompt: \`${fmt(b.systemTokens)}\``,
      `• Tool schemas: \`${fmt(b.toolsTokens)}\` (${b.toolsCount} tools)`,
      `• History: \`${fmt(b.historyTokens)}\` (${b.history.total} messages)`,
      `   - User: ${b.history.user.count} (\`${fmt(b.history.user.tokens)}\`)`,
      `   - Assistant: ${b.history.assistant.count} (\`${fmt(b.history.assistant.tokens)}\`)`,
      `   - Tool: ${b.history.tool.count} (\`${fmt(b.history.tool.tokens)}\`)`,
      `   - Compaction: ${b.history.compaction.count} (\`${fmt(b.history.compaction.tokens)}\`)`,
      `• *Total: ${fmt(b.totalTokens)} tokens (${pct}%)*`,
      ``,
      `*Compaction*`,
      `• Triggers at: ${fmt(b.compactAt)} (${compactPct}%)`,
      `• Keeps recent: ${fmt(b.keepAfter)} verbatim`,
      ``,
      `_Estimates use chars/4; off by ~10–30% depending on language._`,
    ];
    await reply(ctx, body.join("\n"));
  });

  bot.command("compact", async (ctx) => {
    const extra = (ctx.match ?? "").toString().trim();
    const key = sessionKeyFromCtx(ctx);
    await ctx.replyWithChatAction("typing");
    const result = await compactNow({
      key,
      runtime,
      extraInstructions: extra || undefined,
    });
    if (!result.ok) {
      await reply(ctx, `Compaction failed: ${result.error}`);
      return;
    }
    await reply(
      ctx,
      `✓ Compacted ${result.messagesCompacted} message${
        result.messagesCompacted === 1 ? "" : "s"
      }.\n\n*Summary:*\n${result.summary}`,
    );
  });

  bot.command("reload", async (ctx) => {
    if (!options.reloadSkills) {
      await reply(ctx, "Reload is not available in this runtime.");
      return;
    }
    const { count, names } = await options.reloadSkills();
    const list = names.length > 0 ? `\n${names.map((n) => `• ${n}`).join("\n")}` : "";
    await reply(ctx, `Reloaded ${count} skill${count === 1 ? "" : "s"}.${list}`);
  });

  bot.command("setkey", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const args = (ctx.match ?? "").toString().trim().split(/\s+/);
    if (args.length < 2 || !args[0]) {
      await reply(ctx, "Usage: `/setkey <provider> <key>`");
      return;
    }
    const [providerArg, ...keyParts] = args;
    if (!isProvider(providerArg!)) {
      await reply(ctx, `Unknown provider \`${providerArg}\`. Valid: ${PROVIDERS.join(", ")}`);
      return;
    }
    const wasFirstKey = !(await configStore.hasAnyKey());
    await configStore.setKey(providerArg, keyParts.join(" "));

    try {
      await ctx.deleteMessage();
    } catch {
      // bot may lack delete permission
    }

    let msg = `Key for \`${providerArg}\` set ✓`;
    if (wasFirstKey) {
      await configStore.setDefault(providerArg, DEFAULT_MODELS[providerArg]);
      msg += `\nSet as default: \`${providerArg}\` / \`${DEFAULT_MODELS[providerArg]}\``;
    }
    await reply(ctx, msg);
  });

  bot.command("removekey", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const arg = (ctx.match ?? "").toString().trim();
    if (!isProvider(arg)) {
      await reply(ctx, `Usage: \`/removekey <provider>\`. Valid: ${PROVIDERS.join(", ")}`);
      return;
    }
    await configStore.removeKey(arg);
    await reply(ctx, `Key for \`${arg}\` removed.`);
  });

  // One handler pair per aux service, generated from the central registry.
  for (const auxName of AUX_KEYS) {
    const info = AUX_KEY_INFO[auxName];
    bot.command(`set${auxName}key`, async (ctx) => {
      if (!(await isOwner(ctx))) return;
      const arg = (ctx.match ?? "").toString().trim();
      if (!arg) {
        await reply(ctx, `Usage: \`/set${auxName}key <key>\``);
        return;
      }
      await configStore.setAuxKey(auxName, arg);
      try {
        await ctx.deleteMessage();
      } catch {
        // bot may lack delete permission
      }
      await reply(ctx, `${info.label} key set ✓ — ${info.describes} is on.`);
    });

    bot.command(`remove${auxName}key`, async (ctx) => {
      if (!(await isOwner(ctx))) return;
      await configStore.removeAuxKey(auxName);
      await reply(
        ctx,
        `${info.label} key removed — ${info.describes} is off.`,
      );
    });
  }

  bot.command("emoji", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const arg = (ctx.match ?? "").toString().trim();
    if (arg === "clear") {
      await configStore.clearEmojis();
      await reply(ctx, "Custom tool-call emojis cleared. Using default ⏳ ✓ ✗.");
      return;
    }
    const text = ctx.message?.text ?? "";
    const entities = ctx.message?.entities ?? [];
    // Telegram requires entity text to match the custom emoji's fallback char.
    // Read both the ID and the underlying placeholder char from the message.
    const customEmojis = entities
      .filter((e) => e.type === "custom_emoji")
      .map((e) => ({
        id: (e as { custom_emoji_id: string }).custom_emoji_id,
        char: text.substring(e.offset, e.offset + e.length),
      }));

    if (customEmojis.length === 0) {
      const cfg = await configStore.getConfig();
      if (cfg.emojis) {
        await reply(
          ctx,
          `Current tool-call emojis:\n• Running: \`${cfg.emojis.running.id}\` (${cfg.emojis.running.char})\n• Done: \`${cfg.emojis.done.id}\` (${cfg.emojis.done.char})\n• Error: \`${cfg.emojis.error.id}\` (${cfg.emojis.error.char})\n\nSend \`/emoji <running> <done> <error>\` using three custom (animated) emojis to update. Send \`/emoji clear\` to revert.`,
        );
      } else {
        await reply(
          ctx,
          "No custom tool-call emojis set. Send `/emoji <running> <done> <error>` using three custom (animated) emojis from your premium pack — the bot will read them from your message.",
        );
      }
      return;
    }

    if (customEmojis.length < 3) {
      await reply(
        ctx,
        `Got ${customEmojis.length} custom emoji(s). Need 3 in order: running, done, error.`,
      );
      return;
    }

    await configStore.setEmojis({
      running: customEmojis[0]!,
      done: customEmojis[1]!,
      error: customEmojis[2]!,
    });
    await reply(ctx, "Custom tool-call emojis set. They'll appear in tool logs.");
  });

  bot.command("setdefault", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const args = (ctx.match ?? "").toString().trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      const cfg = await configStore.getConfig();
      await ctx.replyWithChatAction("typing");
      const list = await getPickerModels(cfg.default.provider, runtime);
      const text = buildDefaultPickerText(cfg.default.provider, cfg.default.model);
      const kb = list.ok
        ? buildPickerKeyboard(
            "dp",
            cfg.default.provider,
            cfg.default.provider,
            cfg.default.model,
            list.models,
          )
        : buildEmptyPickerKeyboard("dp", cfg.default.provider);
      const body = list.ok ? text : `${text}\n\n_Couldn't fetch models: ${list.error}_`;
      await ctx.reply(body, { parse_mode: "Markdown", reply_markup: kb });
      return;
    }
    const [providerArg, modelArg] = args;
    if (!isProvider(providerArg!)) {
      await reply(ctx, `Unknown provider \`${providerArg}\`. Valid: ${PROVIDERS.join(", ")}`);
      return;
    }
    await configStore.setDefault(providerArg, modelArg);
    const cfg = await configStore.getConfig();
    await reply(ctx, `Default set: \`${cfg.default.provider}\` / \`${cfg.default.model}\``);
  });

  bot.command("provider", async (ctx) => {
    const arg = (ctx.match ?? "").toString().trim();
    const key = sessionKeyFromCtx(ctx);
    if (!arg) {
      const session = await sessionStore.getSession(key);
      const cfg = await configStore.getConfig();
      const effective = session.provider ?? cfg.default.provider;
      const source = session.provider ? "chat" : "default";
      await reply(
        ctx,
        `Provider: \`${effective}\` _(${source})_\nAvailable: ${PROVIDERS.join(", ")}`,
      );
      return;
    }
    if (!isProvider(arg)) {
      await reply(ctx, `Unknown provider \`${arg}\`. Valid: ${PROVIDERS.join(", ")}`);
      return;
    }
    await sessionStore.setSessionProvider(key, arg);
    await reply(
      ctx,
      `Provider for this chat: \`${arg}\` (model reset to \`${DEFAULT_MODELS[arg]}\`)`,
    );
  });

  bot.command("model", async (ctx) => {
    const arg = (ctx.match ?? "").toString().trim();
    const key = sessionKeyFromCtx(ctx);
    if (!arg) {
      const session = await sessionStore.getSession(key);
      const cfg = await configStore.getConfig();
      const effectiveProvider = session.provider ?? cfg.default.provider;
      const effectiveModel =
        session.model ??
        (session.provider ? DEFAULT_MODELS[session.provider] : cfg.default.model);
      const source = session.model ? "chat" : "default";
      await ctx.replyWithChatAction("typing");
      const list = await getPickerModels(effectiveProvider, runtime);
      const text = buildChatPickerText(effectiveProvider, effectiveModel, source);
      const kb = list.ok
        ? buildPickerKeyboard(
            "mp",
            effectiveProvider,
            effectiveProvider,
            effectiveModel,
            list.models,
          )
        : buildEmptyPickerKeyboard("mp", effectiveProvider);
      const body = list.ok ? text : `${text}\n\n_Couldn't fetch models: ${list.error}_`;
      await ctx.reply(body, { parse_mode: "Markdown", reply_markup: kb });
      return;
    }
    await sessionStore.setSessionModel(key, arg);
    await reply(ctx, `Model for this chat: \`${arg}\``);
  });

  // Resolve picker context from a callback. Walks the session/config to
  // figure out what `current` should look like — same logic as `/model` /
  // `/setdefault` no-arg flows.
  async function resolveCurrent(scope: "mp" | "dp", ctx: Context) {
    if (scope === "dp") {
      const cfg = await configStore.getConfig();
      return { provider: cfg.default.provider, model: cfg.default.model };
    }
    const key = sessionKeyFromCtx(ctx);
    const session = await sessionStore.getSession(key);
    const cfg = await configStore.getConfig();
    return {
      provider: session.provider ?? cfg.default.provider,
      model:
        session.model ??
        (session.provider ? DEFAULT_MODELS[session.provider] : cfg.default.model),
    };
  }

  function pickerHeaderText(
    scope: "mp" | "dp",
    provider: Provider,
    model: string,
  ): string {
    return scope === "mp"
      ? buildChatPickerText(provider, model, "chat")
      : buildDefaultPickerText(provider, model);
  }

  // Both pickers share the same callback shape; only the scope prefix
  // differs (`mp` for per-chat /model, `dp` for global /setdefault).
  bot.callbackQuery(/^(mp|dp):(view|refresh):(\w+)$/, async (ctx) => {
    const scope = ctx.match[1] as "mp" | "dp";
    const action = ctx.match[2] as "view" | "refresh";
    const target = ctx.match[3];
    if (!isProvider(target!)) {
      await ctx.answerCallbackQuery({ text: "Unknown provider" });
      return;
    }
    if (scope === "dp" && !(await isOwner(ctx))) {
      await ctx.answerCallbackQuery({ text: "Owner only" });
      return;
    }
    if (action === "refresh") modelCache.delete(target);
    await ctx.answerCallbackQuery(
      action === "refresh" ? { text: "Refreshing…" } : undefined,
    );
    const list = await getPickerModels(target, runtime);
    const cur = await resolveCurrent(scope, ctx);
    const kb = list.ok
      ? buildPickerKeyboard(scope, target, cur.provider, cur.model, list.models)
      : buildEmptyPickerKeyboard(scope, target);
    // Always rewrite the whole message — telegram silently no-ops when
    // nothing changed, and this way we surface fetch errors inline when
    // the user switches to a provider with no key set.
    const text = pickerHeaderText(scope, cur.provider, cur.model);
    const body = list.ok ? text : `${text}\n\n_Couldn't fetch models: ${list.error}_`;
    try {
      await ctx.editMessageText(body, { parse_mode: "Markdown", reply_markup: kb });
    } catch {
      // ignore "message is not modified" and similar
    }
  });

  bot.callbackQuery(/^(mp|dp):set:(\w+):(\d+)$/, async (ctx) => {
    const scope = ctx.match[1] as "mp" | "dp";
    const provider = ctx.match[2];
    const idx = Number.parseInt(ctx.match[3]!, 10);
    if (!isProvider(provider!)) {
      await ctx.answerCallbackQuery({ text: "Unknown provider" });
      return;
    }
    if (scope === "dp" && !(await isOwner(ctx))) {
      await ctx.answerCallbackQuery({ text: "Owner only" });
      return;
    }
    const list = await getPickerModels(provider, runtime);
    if (!list.ok) {
      await ctx.answerCallbackQuery({
        text: `Fetch failed: ${list.error}`,
        show_alert: true,
      });
      return;
    }
    const pick = list.models[idx];
    if (!pick) {
      await ctx.answerCallbackQuery({ text: "Out of range — refresh" });
      return;
    }

    if (scope === "mp") {
      const key = sessionKeyFromCtx(ctx);
      await sessionStore.setSessionProvider(key, provider);
      await sessionStore.setSessionModel(key, pick.id);
    } else {
      await configStore.setDefault(provider, pick.id);
    }
    await ctx.answerCallbackQuery({ text: `✓ ${modelLabel(pick)}` });
    const text = pickerHeaderText(scope, provider, pick.id);
    try {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: buildPickerKeyboard(
          scope,
          provider,
          provider,
          pick.id,
          list.models,
        ),
      });
    } catch {
      // ignore
    }
  });

  bot.command("system", async (ctx) => {
    const arg = (ctx.match ?? "").toString().trim();
    const key = sessionKeyFromCtx(ctx);
    if (!arg) {
      const session = await sessionStore.getSession(key);
      await reply(
        ctx,
        session.systemPromptOverride
          ? `System prompt:\n\n${session.systemPromptOverride}`
          : "No system prompt override for this chat. Use `/system <text>` to set, `/system clear` to remove.",
      );
      return;
    }
    if (arg === "clear") {
      await sessionStore.setSessionSystemPrompt(key, undefined);
      await reply(ctx, "System prompt cleared for this chat.");
      return;
    }
    await sessionStore.setSessionSystemPrompt(key, arg);
    await reply(ctx, "System prompt set for this chat.");
  });

  bot.command("clear", async (ctx) => {
    const key = sessionKeyFromCtx(ctx);
    await chatStore.clearHistory(key);
    await reply(ctx, "History cleared for this chat.");
  });

  bot.command("config", async (ctx) => {
    const key = sessionKeyFromCtx(ctx);
    const session = await sessionStore.getSession(key);
    const cfg = await configStore.getConfig();
    const provider = session.provider ?? cfg.default.provider;
    const model =
      session.model ??
      (session.provider ? DEFAULT_MODELS[session.provider] : cfg.default.model);
    const lines = [
      `*This chat*`,
      `Provider: \`${provider}\` ${session.provider ? "_(chat)_" : "_(default)_"}`,
      `Model: \`${model}\` ${session.model ? "_(chat)_" : "_(default)_"}`,
      `System prompt: ${session.systemPromptOverride ? "_(custom)_" : "_(none)_"}`,
      "",
      `*Defaults*`,
      `Provider: \`${cfg.default.provider}\``,
      `Model: \`${cfg.default.model}\``,
      `Keys: ${PROVIDERS.filter((p) => cfg.keys[p]).join(", ") || "_(none set)_"}`,
    ];
    await reply(ctx, lines.join("\n"));
  });

  bot.command("mcp", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const tokens = (ctx.match ?? "").toString().trim().split(/\s+/).filter(Boolean);
    const sub = tokens[0];

    if (!sub || sub === "list") {
      const servers = await mcpStore.listServers();
      if (servers.length === 0) {
        await reply(ctx, "No MCP servers configured. Use `/mcp add http <name> <url>` to add one.");
        return;
      }
      const lines = servers.map(({ name, server }) =>
        server.transport === "http"
          ? `• \`${name}\` — http \`${server.url}\`${server.bearer ? " 🔒" : ""}`
          : `• \`${name}\` — stdio \`${server.command}\``,
      );
      await reply(ctx, `*MCP servers*\n${lines.join("\n")}`);
      return;
    }

    if (sub === "add") {
      const transport = tokens[1];
      const name = tokens[2];
      if (!name || (transport !== "http" && transport !== "stdio")) {
        await reply(
          ctx,
          "Usage:\n`/mcp add http <name> <url> [bearer]`\n`/mcp add stdio <name> <command> [args...]`",
        );
        return;
      }

      let server: ServerConfig;
      let hadSecret = false;
      if (transport === "http") {
        const url = tokens[3];
        const bearer = tokens[4];
        if (!url) {
          await reply(ctx, "Missing URL");
          return;
        }
        server = { transport: "http", url, ...(bearer ? { bearer } : {}) };
        hadSecret = !!bearer;
      } else {
        const command = tokens[3];
        if (!command) {
          await reply(ctx, "Missing command");
          return;
        }
        server = { transport: "stdio", command, args: tokens.slice(4) };
      }

      if (hadSecret) {
        try {
          await ctx.deleteMessage();
        } catch {
          // bot may lack delete permission
        }
      }

      await mcpStore.addServer(name, server);
      const result = await mcp.load();
      const errs = result.errors.length
        ? `\nErrors:\n${result.errors.map((e) => `• ${e.name}: ${e.message}`).join("\n")}`
        : "";
      await reply(
        ctx,
        `Added \`${name}\`. ${result.servers} server(s) connected, ${result.tools} tool(s) loaded.${errs}`,
      );
      return;
    }

    if (sub === "remove") {
      const name = tokens[1];
      if (!name) {
        await reply(ctx, "Usage: `/mcp remove <name>`");
        return;
      }
      const removed = await mcpStore.removeServer(name);
      if (!removed) {
        await reply(ctx, `No server named \`${name}\`.`);
        return;
      }
      const result = await mcp.load();
      await reply(
        ctx,
        `Removed \`${name}\`. ${result.servers} server(s) connected, ${result.tools} tool(s) loaded.`,
      );
      return;
    }

    if (sub === "reload") {
      const result = await mcp.load();
      const errs = result.errors.length
        ? `\nErrors:\n${result.errors.map((e) => `• ${e.name}: ${e.message}`).join("\n")}`
        : "";
      await reply(
        ctx,
        `Reloaded. ${result.servers} server(s) connected, ${result.tools} tool(s) loaded.${errs}`,
      );
      return;
    }

    await reply(ctx, "Unknown subcommand. Try: `list`, `add`, `remove`, `reload`");
  });

  bot.command("users", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const approved = await configStore.listApprovedUsers();
    const pending = await configStore.listPendingApprovals();
    const lines: string[] = [];
    lines.push(`*Approved (${approved.length})*`);
    if (approved.length === 0) lines.push("_(none)_");
    else for (const id of approved) lines.push(`• \`${id}\``);
    lines.push("");
    lines.push(`*Pending (${pending.length})*`);
    if (pending.length === 0) lines.push("_(none)_");
    else
      for (const p of pending) {
        const minsLeft = Math.max(
          0,
          Math.round((60 * 60 * 1000 - (Date.now() - p.createdAt)) / 60000),
        );
        const who = p.name ? `${p.name} (\`${p.userId}\`)` : `\`${p.userId}\``;
        lines.push(`• ${who} — code \`${p.code}\` (${minsLeft}m left)`);
      }
    await reply(ctx, lines.join("\n"));
  });

  bot.command("approve", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const code = (ctx.match ?? "").toString().trim().toUpperCase();
    if (!code) {
      await reply(ctx, "Usage: `/approve <code>`");
      return;
    }
    const approved = await configStore.approveByCode(code);
    if (!approved) {
      await reply(ctx, `Invalid or expired code \`${code}\`.`);
      return;
    }
    const who = approved.name ? `${approved.name} (\`${approved.userId}\`)` : `\`${approved.userId}\``;
    await reply(ctx, `Approved ${who}.`);
    try {
      await ctx.api.sendMessage(
        approved.userId,
        "✅ You've been approved. Type any message to start chatting. Use /help to see commands.",
      );
    } catch (err) {
      console.error("[bot] failed to notify approved user:", err);
    }
  });

  bot.command("revoke", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const arg = (ctx.match ?? "").toString().trim();
    const userId = Number.parseInt(arg, 10);
    if (!Number.isFinite(userId)) {
      await reply(ctx, "Usage: `/revoke <userId>`");
      return;
    }
    const removed = await configStore.revokeUser(userId);
    await reply(ctx, removed ? `Revoked \`${userId}\`.` : `\`${userId}\` was not approved.`);
  });
}
