import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { fetchAvailableModels } from "./model-list.ts";
import {
  AUX_KEYS,
  AUX_KEY_INFO,
  DEFAULT_MODELS,
  PROVIDERS,
  createConfigStore,
  isProvider,
  type AuxKey,
  type Provider,
} from "../store/config.ts";
import type { SessionKey } from "../store/types.ts";
import type { BotRuntime } from "../runtime/index.ts";
import { botPaths } from "../runtime/paths.ts";
import {
  getRegistry,
  listAgents,
  setPendingSpawn,
} from "../runtime/registry.ts";

export type BotInfo = {
  username: string;
  canManageBots: boolean;
};

export type AdminToolContext = {
  key: SessionKey;
  userId: number;
  runtime: BotRuntime;
  notifyUser?: (userId: number, message: string) => Promise<void>;
  getBotInfo?: () => Promise<BotInfo>;
  triggerAgent?: (
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
  reloadSkills?: () => Promise<{ count: number; names: string[] }>;
};

function findAgentByIdentifier<
  T extends {
    botId: number;
    name: string;
    username: string;
    aliases?: string[];
  },
>(agents: T[], identifier: string): T | undefined {
  const needle = identifier.toLowerCase().replace(/^@/, "");
  return agents.find(
    (a) =>
      String(a.botId) === identifier ||
      a.name.toLowerCase() === needle ||
      a.username.toLowerCase() === needle ||
      a.aliases?.some((alias) => alias.toLowerCase() === needle),
  );
}

/** Union of every key kind that can be shared between bots. */
type ShareableKey = Provider | AuxKey;
const SHAREABLE_KEYS: readonly ShareableKey[] = [
  ...PROVIDERS,
  ...AUX_KEYS,
] as const;

function isShareableKey(value: string): value is ShareableKey {
  return (SHAREABLE_KEYS as readonly string[]).includes(value);
}

async function copySingleKey(
  managerCfg: {
    keys: Partial<Record<Provider, string>>;
    auxKeys: Partial<Record<AuxKey, string>>;
  },
  targetConfig: ReturnType<typeof createConfigStore>,
  key: ShareableKey,
): Promise<boolean> {
  if ((AUX_KEYS as readonly string[]).includes(key)) {
    const auxName = key as AuxKey;
    const val = managerCfg.auxKeys[auxName];
    if (!val) return false;
    await targetConfig.setAuxKey(auxName, val);
    return true;
  }
  const val = managerCfg.keys[key as Provider];
  if (!val) return false;
  await targetConfig.setKey(key as Provider, val);
  return true;
}

/**
 * Look up the recipient's user info (id / name / username) from a bot's
 * chat history. Used to enrich the trigger_agent notify result so the
 * calling agent can narrate "I sent X to <real name>" instead of
 * confusing chat IDs or hallucinated names.
 */
async function lookupRecipientInfo(
  runtime: BotRuntime,
  chatId: number,
): Promise<{ chat_id: number; id?: number; name?: string; username?: string } | null> {
  try {
    const history = await runtime.chatStore.readHistory({ chatId });
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m && m.from && m.message.role === "user") {
        return {
          chat_id: chatId,
          id: m.from.id,
          name: m.from.name,
          username: m.from.username,
        };
      }
    }
  } catch {
    // ignore — we'll fall back to chat_id only
  }
  return null;
}

async function lookupRecipientInfoByBotId(
  botId: number,
  chatId: number,
): Promise<{ chat_id: number; id?: number; name?: string; username?: string } | null> {
  try {
    const { createChatStore } = await import("../store/chats.ts");
    const store = createChatStore(botPaths(botId));
    const history = await store.readHistory({ chatId });
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m && m.from && m.message.role === "user") {
        return {
          chat_id: chatId,
          id: m.from.id,
          name: m.from.name,
          username: m.from.username,
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function suggestUsername(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "agent";
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base}_${rand}_bot`;
}

export async function buildAdminTools(
  ctx: AdminToolContext,
): Promise<ToolSet> {
  const ownerId = await ctx.runtime.getOwnerId();
  const isOwner = ctx.userId === ownerId;
  const registry = await getRegistry();
  const isManager = registry.managerBotId === ctx.runtime.botId;

  const userTools = {
    get_chat_config: tool({
      description:
        "Show this chat's effective provider, model, system prompt, and per-bot defaults.",
      inputSchema: z.object({}),
      execute: async () => {
        const session = await ctx.runtime.sessionStore.getSession(ctx.key);
        const cfg = await ctx.runtime.configStore.getConfig();
        const provider = session.provider ?? cfg.default.provider;
        const model =
          session.model ??
          (session.provider
            ? DEFAULT_MODELS[session.provider]
            : cfg.default.model);
        return {
          chatId: ctx.key.chatId,
          provider,
          providerSource: session.provider ? "chat" : "default",
          model,
          modelSource: session.model ? "chat" : "default",
          systemPromptOverride: session.systemPromptOverride ?? null,
          defaults: cfg.default,
          configuredProviders: PROVIDERS.filter((p) => cfg.keys[p]),
        };
      },
    }),

    set_provider: tool({
      description:
        "Set the LLM provider for this chat. Resets the chat's model to the provider's default.",
      inputSchema: z.object({
        provider: z
          .string()
          .refine(isProvider, `Provider must be one of: ${PROVIDERS.join(", ")}`),
      }),
      execute: async ({ provider }) => {
        await ctx.runtime.sessionStore.setSessionProvider(
          ctx.key,
          provider,
        );
        return { ok: true, provider, defaultModel: DEFAULT_MODELS[provider] };
      },
    }),

    set_model: tool({
      description:
        "Set the LLM model for this chat. Model id format depends on the active provider (e.g. 'anthropic/claude-sonnet-4.6' for gateway, 'gpt-4o' for openai direct).",
      inputSchema: z.object({
        model: z.string().min(1),
      }),
      execute: async ({ model }) => {
        await ctx.runtime.sessionStore.setSessionModel(ctx.key, model);
        return { ok: true, model };
      },
    }),

    set_system_prompt: tool({
      description:
        "Set or update the system prompt override for this chat.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async ({ text }) => {
        await ctx.runtime.sessionStore.setSessionSystemPrompt(ctx.key, text);
        return { ok: true };
      },
    }),

    clear_system_prompt: tool({
      description:
        "Remove the system prompt override for this chat, falling back to defaults.",
      inputSchema: z.object({}),
      execute: async () => {
        await ctx.runtime.sessionStore.setSessionSystemPrompt(
          ctx.key,
          undefined,
        );
        return { ok: true };
      },
    }),

    list_provider_keys: tool({
      description:
        "List which providers have API keys configured. Returns booleans only — never the keys themselves.",
      inputSchema: z.object({}),
      execute: async () => {
        const cfg = await ctx.runtime.configStore.getConfig();
        return Object.fromEntries(
          PROVIDERS.map((p) => [p, !!cfg.keys[p]]),
        ) as Record<(typeof PROVIDERS)[number], boolean>;
      },
    }),

    list_skills_available: tool({
      description: "List all skills available to the agent.",
      inputSchema: z.object({}),
      execute: async () => {
        return ctx.runtime.skills.map((s) => ({
          name: s.name,
          description: s.description,
          compatibility: s.compatibility,
        }));
      },
    }),

    reload_skills: tool({
      description:
        "Re-scan the skill roots (~/.cookiedclaw/skills, ~/.agents/skills, ./.agents/skills) and refresh the in-memory skill list. Call this after the user installs new skills via `npx skills add <repo>` so the agent can use them without restarting the bot.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!ctx.reloadSkills) {
          return { ok: false, error: "Reload not available in this runtime." };
        }
        const result = await ctx.reloadSkills();
        return { ok: true, ...result };
      },
    }),

    list_models: tool({
      description:
        "List currently available models for the active provider, fetched live from the provider's API. ALWAYS call this when the user asks 'what models are there', 'is X model available', or wants to switch — your training data is out of date and may not include the newest models.",
      inputSchema: z.object({
        provider: z
          .string()
          .refine(isProvider)
          .optional()
          .describe(
            "Provider to list models for. Defaults to this chat's effective provider.",
          ),
      }),
      execute: async ({ provider }, options) => {
        const cfg = await ctx.runtime.configStore.getConfig();
        const session = await ctx.runtime.sessionStore.getSession(ctx.key);
        const effective = (provider ??
          session.provider ??
          cfg.default.provider) as Provider;

        const result = await fetchAvailableModels(
          effective,
          cfg,
          options?.abortSignal,
        );
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
        return { ok: true, provider: effective, models: result.models };
      },
    }),

    list_mcp_servers: tool({
      description: "List configured MCP servers (name + transport).",
      inputSchema: z.object({}),
      execute: async () => {
        const servers = await ctx.runtime.mcpStore.listServers();
        return servers.map(({ name, server }) =>
          server.transport === "http"
            ? {
                name,
                transport: "http" as const,
                url: server.url,
                authenticated: !!server.bearer,
              }
            : {
                name,
                transport: "stdio" as const,
                command: server.command,
              },
        );
      },
    }),
  };

  if (!isOwner) return userTools;

  const ownerTools = {
    set_default_provider: tool({
      description:
        "OWNER ONLY. Set the bot's global default provider and optionally model.",
      inputSchema: z.object({
        provider: z.string().refine(isProvider),
        model: z.string().optional(),
      }),
      execute: async ({ provider, model }) => {
        await ctx.runtime.configStore.setDefault(provider, model);
        const cfg = await ctx.runtime.configStore.getConfig();
        return { ok: true, default: cfg.default };
      },
    }),

    remove_provider_key: tool({
      description: "OWNER ONLY. Remove the API key for a provider.",
      inputSchema: z.object({
        provider: z.string().refine(isProvider),
      }),
      execute: async ({ provider }) => {
        await ctx.runtime.configStore.removeKey(provider);
        return { ok: true };
      },
    }),

    mcp_add_http: tool({
      description:
        "OWNER ONLY. Add an unauthenticated HTTP MCP server. For authenticated servers (with bearer token), use the /mcp add http command directly so the token isn't exposed in chat history.",
      inputSchema: z.object({
        name: z.string().min(1),
        url: z.string().url(),
      }),
      execute: async ({ name, url }) => {
        await ctx.runtime.mcpStore.addServer(name, {
          transport: "http",
          url,
        });
        const result = await ctx.runtime.mcp.load();
        return { ok: true, ...result };
      },
    }),

    mcp_add_stdio: tool({
      description: "OWNER ONLY. Add a stdio MCP server.",
      inputSchema: z.object({
        name: z.string().min(1),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
      }),
      execute: async ({ name, command, args }) => {
        await ctx.runtime.mcpStore.addServer(name, {
          transport: "stdio",
          command,
          args,
        });
        const result = await ctx.runtime.mcp.load();
        return { ok: true, ...result };
      },
    }),

    mcp_remove: tool({
      description: "OWNER ONLY. Remove an MCP server.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        const removed = await ctx.runtime.mcpStore.removeServer(name);
        if (!removed) return { ok: false, error: "Server not found" };
        const result = await ctx.runtime.mcp.load();
        return { ok: true, ...result };
      },
    }),

    mcp_reload: tool({
      description: "OWNER ONLY. Reconnect all MCP servers.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await ctx.runtime.mcp.load();
        return { ok: true, ...result };
      },
    }),

    list_approved_users: tool({
      description: "OWNER ONLY. List user IDs approved for this bot.",
      inputSchema: z.object({}),
      execute: async () => ({
        approved: await ctx.runtime.configStore.listApprovedUsers(),
      }),
    }),

    list_pending_users: tool({
      description: "OWNER ONLY. List pending approval requests with codes.",
      inputSchema: z.object({}),
      execute: async () => ({
        pending: await ctx.runtime.configStore.listPendingApprovals(),
      }),
    }),

    approve_user: tool({
      description:
        "OWNER ONLY. Approve a pending user by their code. Notifies the approved user via DM if possible.",
      inputSchema: z.object({ code: z.string().min(1) }),
      execute: async ({ code }) => {
        const approved = await ctx.runtime.configStore.approveByCode(
          code.toUpperCase(),
        );
        if (!approved) {
          return { ok: false, error: "Invalid or expired code" };
        }
        if (ctx.notifyUser) {
          await ctx.notifyUser(
            approved.userId,
            "✅ You've been approved. Type any message to start chatting. Use /help to see commands.",
          );
        }
        return { ok: true, approved };
      },
    }),

    revoke_user: tool({
      description: "OWNER ONLY. Revoke a user's access to this bot.",
      inputSchema: z.object({ userId: z.number().int() }),
      execute: async ({ userId }) => {
        const removed = await ctx.runtime.configStore.revokeUser(userId);
        return { ok: removed };
      },
    }),
  };

  // Tools available to every owner (manager + each spawned agent), defined
  // here so the early non-manager return below can include them.
  const ownerExtraToolsForAllOwners = buildOwnerExtraTools(ctx, isManager);

  if (!isManager)
    return { ...userTools, ...ownerTools, ...ownerExtraToolsForAllOwners };

  const managerTools = {
    spawn_agent: tool({
      description:
        "OWNER + MANAGER BOT ONLY. Generate a Telegram link to create a new agent bot. The owner taps the link and confirms in Telegram's UI; once confirmed, the new bot goes live with keys + MCP inherited from this manager. Use when the user asks for a new agent/bot/assistant. IMPORTANT: do not call this until the user has given a name. If the user describes purpose, persona, language, tone, or audience (e.g. 'a Russian-speaking bot named Polina who plays board games'), pass `initial_memories` — short facts seeding the agent's long-term memory — AND `aliases` listing every name the agent should answer to (the persona's first name, nicknames, etc.). The aliases let future calls disambiguate when the owner says 'у Сани спросить' instead of 'ask Beatforge'.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Display name for the new bot (BotFather profile name, e.g. 'Beatforge')."),
        initial_memories: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Short factual sentences that seed the new bot's memory (one fact per item). Examples: 'My name is Polina', 'I speak Russian', 'I prefer warm and friendly tone', 'I like indie games'. Each becomes a separate memory.",
          ),
        aliases: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Other names the agent answers to — typically the persona's name from initial_memories. Example: bot is named 'Beatforge' on BotFather but the persona introduced via memories is 'Саня', so pass `['Саня']`. Aliases let `trigger_agent` find the right bot when the owner uses the persona name instead of the bot's display name.",
          ),
      }),
      execute: async ({ name, initial_memories, aliases }) => {
        const info = await ctx.getBotInfo?.();
        if (info && !info.canManageBots) {
          return {
            ok: false,
            error: "bot_management_disabled",
            message:
              `@${info.username} does not have Bot Management Mode enabled. To fix:\n` +
              `1. Open @BotFather\n` +
              `2. Send /mybots → select @${info.username}\n` +
              `3. Bot Settings → enable Bot Management\n` +
              `Then ask me again.`,
          };
        }
        const username = info?.username ?? registry.managerUsername;
        if (!username) {
          return { ok: false, error: "Manager username unknown" };
        }
        if (
          (initial_memories && initial_memories.length > 0) ||
          (aliases && aliases.length > 0)
        ) {
          await setPendingSpawn(name, {
            initialMemories: initial_memories,
            aliases,
          });
        }
        const suggested = suggestUsername(name);
        const url = `https://t.me/newbot/${username}/${suggested}?name=${encodeURIComponent(name)}`;
        return {
          ok: true,
          name,
          aliases,
          url,
          memories_seeded: initial_memories?.length ?? 0,
          next_steps:
            "Tap the link and confirm in Telegram. The new bot will go live and (if memories were seeded) start with that context already in long-term memory.",
        };
      },
    }),

    set_agent_default: tool({
      description:
        "OWNER + MANAGER BOT ONLY. Change the default provider and/or model for one of the spawned agent bots. Writes to that agent's own config; the change takes effect on its next message. If you only want to change the model, omit `provider` and we'll keep its current provider.",
      inputSchema: z.object({
        agent: z
          .string()
          .min(1)
          .describe("Agent identifier — display name, @username, or numeric bot ID."),
        provider: z
          .string()
          .refine(isProvider)
          .optional()
          .describe("New default provider. If omitted, keeps the agent's current provider."),
        model: z
          .string()
          .optional()
          .describe(
            "New default model. If both provider and model are omitted, returns the current default without changes.",
          ),
      }),
      execute: async ({ agent, provider, model }) => {
        const agents = await listAgents();
        const needle = agent.toLowerCase().replace(/^@/, "");
        const target = agents.find(
          (a) =>
            String(a.botId) === agent ||
            a.name.toLowerCase() === needle ||
            a.username.toLowerCase() === needle,
        );
        if (!target) {
          return {
            ok: false,
            error: `No agent matches "${agent}". Use list_spawned_agents to see options.`,
          };
        }
        const targetConfig = createConfigStore(botPaths(target.botId));
        const targetCfg = await targetConfig.getConfig();
        if (!provider && !model) {
          return { ok: true, agent: target.name, default: targetCfg.default };
        }
        const nextProvider = provider ?? targetCfg.default.provider;
        await targetConfig.setDefault(nextProvider, model);

        // If switching to a provider the target doesn't have a key for, copy
        // it from the manager (if manager has it). Saves the user from having
        // to /setkey on the spawned bot directly.
        let keyCopied = false;
        if (!targetCfg.keys[nextProvider]) {
          const managerCfg = await ctx.runtime.configStore.getConfig();
          const managerKey = managerCfg.keys[nextProvider];
          if (managerKey) {
            await targetConfig.setKey(nextProvider, managerKey);
            keyCopied = true;
          }
        }
        const updated = (await targetConfig.getConfig()).default;
        const noKey =
          !keyCopied &&
          !(await targetConfig.getConfig()).keys[nextProvider];
        return {
          ok: true,
          agent: target.name,
          default: updated,
          key_copied_from_manager: keyCopied,
          warning: noKey
            ? `${target.name} has no API key for ${nextProvider}. The agent will error on next message until /setkey is set on it.`
            : undefined,
        };
      },
    }),

    share_key_with_agent: tool({
      description:
        "OWNER + MANAGER BOT ONLY. Copy a single API key from this manager to a spawned agent. Use when the user says things like 'дай Полине ключ от openrouter', 'give Sanya the memory key', 'agent X needs the tavily key'.",
      inputSchema: z.object({
        agent: z
          .string()
          .min(1)
          .describe("Agent name, @username, or numeric bot ID."),
        key: z
          .string()
          .refine(isShareableKey, `Key must be one of: ${SHAREABLE_KEYS.join(", ")}`)
          .describe(
            `Which key to copy. LLM provider: ${PROVIDERS.join(" / ")}. Aux: ${AUX_KEYS.map(
              (k) => `${k} = ${AUX_KEY_INFO[k].describes}`,
            ).join("; ")}.`,
          ),
      }),
      execute: async ({ agent, key }) => {
        const target = findAgentByIdentifier(await listAgents(), agent);
        if (!target) {
          return {
            ok: false,
            error: `No agent matches "${agent}".`,
          };
        }
        const managerCfg = await ctx.runtime.configStore.getConfig();
        const targetConfig = createConfigStore(botPaths(target.botId));
        const ok = await copySingleKey(managerCfg, targetConfig, key);
        if (!ok) {
          return {
            ok: false,
            error: `The manager has no ${key} key configured. Set it via the matching slash command first.`,
          };
        }
        return { ok: true, agent: target.name, copied: key };
      },
    }),

    share_all_keys_with_agent: tool({
      description:
        "OWNER + MANAGER BOT ONLY. Copy ALL of the manager's configured keys (every LLM provider key + every aux key — memory, tavily, fal, ...) to a spawned agent. Use when the user wants to sync everything, e.g. 'дай Полине все мои ключи' / 'sync keys with Beatforge'.",
      inputSchema: z.object({
        agent: z
          .string()
          .min(1)
          .describe("Agent name, @username, or numeric bot ID."),
      }),
      execute: async ({ agent }) => {
        const target = findAgentByIdentifier(await listAgents(), agent);
        if (!target) {
          return {
            ok: false,
            error: `No agent matches "${agent}".`,
          };
        }
        const managerCfg = await ctx.runtime.configStore.getConfig();
        const targetConfig = createConfigStore(botPaths(target.botId));
        const candidates: ShareableKey[] = [
          ...(Object.keys(managerCfg.keys) as Provider[]),
          ...AUX_KEYS.filter((k) => Boolean(managerCfg.auxKeys[k])),
        ];
        const copied: string[] = [];
        for (const k of candidates) {
          if (await copySingleKey(managerCfg, targetConfig, k)) copied.push(k);
        }
        return { ok: true, agent: target.name, copied };
      },
    }),

    list_spawned_agents: tool({
      description:
        "OWNER + MANAGER BOT ONLY. List all agent bots spawned from this manager.",
      inputSchema: z.object({}),
      execute: async () => ({ agents: await listAgents() }),
    }),
  };

  return { ...userTools, ...ownerTools, ...managerTools, ...ownerExtraToolsForAllOwners };
}

function buildOwnerExtraTools(
  ctx: AdminToolContext,
  isManager: boolean,
): ToolSet {
  return {
    list_chats: tool({
      description:
        "OWNER ONLY. List every chat where THIS bot is active, sorted by most-recent activity. For each: chat_id, last user (id / name / username) from chat history, last_active timestamp, message count. Use this to find a specific person on this bot — e.g. 'find Polina's chat_id' — then pass that chat_id to `trigger_agent` (with `agent` omitted) to write to her on this same bot.",
      inputSchema: z.object({}),
      execute: async () => {
        const sessions = await ctx.runtime.sessionStore.listSessions();
        const chats = await Promise.all(
          sessions.map(async (s) => {
            const history = await ctx.runtime.chatStore.readHistory({
              chatId: s.chatId,
            });
            let lastUser:
              | { id: number; name?: string; username?: string }
              | undefined;
            let userMsgCount = 0;
            for (let i = history.length - 1; i >= 0; i--) {
              const m = history[i];
              if (!m || m.message.role !== "user") continue;
              userMsgCount++;
              if (!lastUser && m.from) lastUser = m.from;
            }
            return {
              chat_id: s.chatId,
              last_user: lastUser,
              last_active: new Date(s.lastActive).toISOString(),
              message_count: history.length,
              user_message_count: userMsgCount,
            };
          }),
        );
        chats.sort(
          (a, b) =>
            new Date(b.last_active).getTime() -
            new Date(a.last_active).getTime(),
        );
        return { count: chats.length, chats };
      },
    }),

    trigger_agent: tool({
      description: [
        "Three distinct flows depending on `mode`:",
        "",
        "**`mode: \"delegate\"` (default)** — pure RPC. The target agent's full loop runs with `prompt` as a message from you. Reply (text + embeds) returns to YOU; nothing is sent anywhere. Re-embed attachments via `[embed:<source>]` in your own reply to the owner. Use when you want the result back to inspect/reformat.",
        "",
        "**`mode: \"notify\"`** — literal text → target's chat (target's LLM NOT invoked). `prompt` is the verbatim Telegram message; `embeds` are attachments. Use for interpersonal communication: 'send Sanya this meme', 'передай Полине привет'. Compose the message yourself in the owner's voice. Result confirms delivery only.",
        "",
        "**`mode: \"relay\"` (NEW)** — Target's full LLM runs with `prompt` as a task; the resulting reply (text + any embeds the target produced) is delivered **directly to the OWNER's chat (the chat you're talking in right now)** via this bot. Use when the owner asks: 'have Beatforge make me a track and send it', 'попроси Полину написать стих' — i.e. the artifact comes back to the owner, in the target's voice, without you re-narrating. After the call, you don't need to forward anything; just confirm to the owner that the agent is on it / has delivered.",
        "",
        "Targeting:",
        "- **Same bot, different chat** (any owner): omit `agent`, pass `chat_id`. Find chat_id via `list_chats`.",
        "- **Cross-bot, manager only**: pass `agent` = spawned bot's name / @username / botId / persona alias. `chat_id` defaults to that bot's first approved user.",
      ].join("\n"),
      inputSchema: z.object({
        agent: z
          .string()
          .optional()
          .describe(
            "Spawned agent's name / @username / botId / persona alias. Omit to target THIS bot in another chat.",
          ),
        prompt: z
          .string()
          .min(1)
          .describe(
            "delegate / relay: instruction for the target agent ('generate a 90s synthwave track ~2min'). notify: the literal Telegram text to deliver verbatim.",
          ),
        chat_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Target chat ID. Required when `agent` is omitted. For cross-bot, optional (defaults to spawned agent's first approved user).",
          ),
        mode: z
          .enum(["delegate", "notify", "relay"])
          .optional()
          .describe(
            "`delegate` (default): RPC. `notify`: literal-message relay to target chat. `relay`: target LLM runs, output delivered to owner's current chat (this one).",
          ),
        embeds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "notify mode only: paths / URLs to attach (photos, files). Sent after the text message. Ignored in delegate / relay.",
          ),
      }),
      execute: async (
        { agent, prompt, chat_id, mode = "delegate", embeds },
        options,
      ) => {
        if (!ctx.triggerAgent) {
          return {
            ok: false,
            error: "Cross-agent triggering is not available in this runtime.",
          };
        }
        const callerChatId =
          mode === "relay" ? ctx.key.chatId : undefined;

        // Self-target: this bot, different chat.
        if (!agent) {
          if (!chat_id) {
            return {
              ok: false,
              error:
                "Pass `chat_id` when targeting this bot in another chat. Use list_chats to find the right id.",
            };
          }
          const result = await ctx.triggerAgent(
            ctx.runtime.botId,
            chat_id,
            prompt,
            options?.abortSignal,
            { mode, embeds, callerChatId },
          );
          if (!result.ok) return result;
          const selfRecipient = await lookupRecipientInfo(
            ctx.runtime,
            chat_id,
          );
          if (mode === "notify") {
            return {
              ok: true,
              mode: "notify" as const,
              executed_in_chat: chat_id,
              via: "self",
              delivered_to: selfRecipient ?? { chat_id },
              outgoing_message: result.reply,
              note: `Sent to ${selfRecipient?.name ?? `chat ${chat_id}`}. NOT their reply — they have not responded. Confirm delivery to the owner; do not fabricate their voice.`,
            };
          }
          if (mode === "relay") {
            return {
              ok: true,
              mode: "relay" as const,
              executed_in_chat: chat_id,
              via: "self",
              delivered_to_owner_chat: ctx.key.chatId,
              note: "The target's reply has been delivered DIRECTLY to the owner's chat. You don't need to forward or repeat it — just confirm to the owner that it's done (or stay silent if appropriate).",
            };
          }
          return {
            ok: true,
            mode: "delegate" as const,
            executed_in_chat: chat_id,
            via: "self",
            reply: result.reply,
            embeds: result.embeds,
          };
        }
        // Cross-bot: only the manager can dispatch to spawned agents.
        if (!isManager) {
          return {
            ok: false,
            error:
              "Only the manager bot can trigger spawned agents. Omit `agent` to target this bot in another chat.",
          };
        }
        const target = findAgentByIdentifier(await listAgents(), agent);
        if (!target) {
          return {
            ok: false,
            error: `No agent matches "${agent}". Use list_spawned_agents to see options.`,
          };
        }
        let chatId = chat_id;
        if (!chatId) {
          const targetConfig = createConfigStore(botPaths(target.botId));
          const approved = await targetConfig.listApprovedUsers();
          chatId = approved[0];
        }
        if (!chatId) {
          return {
            ok: false,
            error: `@${target.username} has no approved users yet — pass chat_id explicitly.`,
          };
        }
        const result = await ctx.triggerAgent(
          target.botId,
          chatId,
          prompt,
          options?.abortSignal,
          { mode, embeds, callerChatId },
        );
        if (!result.ok) return result;
        if (mode === "notify") {
          const recipientInfo = await lookupRecipientInfoByBotId(
            target.botId,
            chatId,
          );
          return {
            ok: true,
            mode: "notify" as const,
            executed_in_chat: chatId,
            via: `@${target.username}`,
            agent_name: target.name,
            delivered_to: recipientInfo ?? { chat_id: chatId },
            outgoing_message: result.reply,
            note: `Sent to ${recipientInfo?.name ?? `chat ${chatId}`} via @${target.username}. The recipient is the HUMAN that uses @${target.username}, NOT the bot's persona. NOT their reply — they have not responded. Confirm delivery to the owner; do not fabricate their voice.`,
          };
        }
        if (mode === "relay") {
          return {
            ok: true,
            mode: "relay" as const,
            executed_in_chat: chatId,
            via: `@${target.username}`,
            agent_name: target.name,
            delivered_to_owner_chat: ctx.key.chatId,
            note: `${target.name}'s reply has been delivered DIRECTLY to the owner's chat. You don't need to forward or repeat it — just confirm to the owner that ${target.name} delivered (or stay silent if appropriate).`,
          };
        }
        return {
          ok: true,
          mode: "delegate" as const,
          executed_in_chat: chatId,
          via: `@${target.username}`,
          agent_name: target.name,
          reply: result.reply,
          embeds: result.embeds,
        };
      },
    }),
  };
}
