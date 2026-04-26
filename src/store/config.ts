import type { BotPaths } from "../runtime/paths.ts";

export type Provider = "gateway" | "openrouter" | "anthropic" | "openai";

export const PROVIDERS: readonly Provider[] = [
  "gateway",
  "openrouter",
  "anthropic",
  "openai",
] as const;

export const DEFAULT_MODELS: Record<Provider, string> = {
  gateway: "anthropic/claude-sonnet-4.6",
  openrouter: "anthropic/claude-sonnet-4-6",
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
};

/**
 * Auxiliary services with their own API keys (orthogonal to the LLM
 * provider keys above). Single source of truth for slash commands, the
 * cross-agent share helper, and runtime tool gating — adding a new aux
 * service is a one-line change here plus a tool builder.
 */
export const AUX_KEYS = ["memory", "tavily", "fal"] as const;
export type AuxKey = (typeof AUX_KEYS)[number];

export const AUX_KEY_INFO: Record<
  AuxKey,
  { label: string; describes: string; signupUrl: string }
> = {
  memory: {
    label: "Supermemory",
    describes: "long-term memory",
    signupUrl: "https://supermemory.ai",
  },
  tavily: {
    label: "Tavily",
    describes: "web_search and web_fetch",
    signupUrl: "https://app.tavily.com",
  },
  fal: {
    label: "fal.ai",
    describes: "image generation + storage uploads",
    signupUrl: "https://fal.ai",
  },
};

export function isAuxKey(value: string): value is AuxKey {
  return (AUX_KEYS as readonly string[]).includes(value);
}

export type PendingApproval = {
  userId: number;
  name?: string;
  createdAt: number;
};

export type ToolEmoji = {
  /** Custom emoji ID from the user's premium pack. */
  id: string;
  /** Fallback character that Telegram requires at the entity position. */
  char: string;
};

export type ToolEmojis = {
  running: ToolEmoji;
  done: ToolEmoji;
  error: ToolEmoji;
};

export type GlobalConfig = {
  approvedUsers: number[];
  pendingApprovals: Record<string, PendingApproval>;
  /** LLM provider keys (gateway/openrouter/anthropic/openai). */
  keys: Partial<Record<Provider, string>>;
  /** Auxiliary service keys (memory/tavily/fal/...). */
  auxKeys: Partial<Record<AuxKey, string>>;
  emojis?: ToolEmojis;
  default: { provider: Provider; model: string };
};

const DEFAULT_CONFIG: GlobalConfig = {
  approvedUsers: [],
  pendingApprovals: {},
  keys: {},
  auxKeys: {},
  default: { provider: "gateway", model: DEFAULT_MODELS.gateway },
};

const PENDING_TTL_MS = 60 * 60 * 1000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;

function generateCode(taken: Record<string, unknown>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!(code in taken)) return code;
  }
  throw new Error("Could not generate unique code");
}

function pruneExpired(c: GlobalConfig): void {
  const now = Date.now();
  for (const [code, p] of Object.entries(c.pendingApprovals)) {
    if (now - p.createdAt > PENDING_TTL_MS) delete c.pendingApprovals[code];
  }
}

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Migrate the legacy flat-field shape (`memoryKey` / `tavilyKey` / `falKey`
 * at the top level) into the unified `auxKeys` map. Old config files keep
 * working; on the next save the legacy fields drop off disk.
 */
type LegacyConfigShape = Partial<GlobalConfig> & {
  memoryKey?: string;
  tavilyKey?: string;
  falKey?: string;
};

function readAuxKeys(stored: LegacyConfigShape): Partial<Record<AuxKey, string>> {
  const out: Partial<Record<AuxKey, string>> = { ...(stored.auxKeys ?? {}) };
  if (stored.memoryKey && !out.memory) out.memory = stored.memoryKey;
  if (stored.tavilyKey && !out.tavily) out.tavily = stored.tavilyKey;
  if (stored.falKey && !out.fal) out.fal = stored.falKey;
  return out;
}

export function createConfigStore(paths: BotPaths) {
  let cache: GlobalConfig | null = null;

  async function load(): Promise<GlobalConfig> {
    if (cache) return cache;
    const file = Bun.file(paths.configFile);
    if (await file.exists()) {
      const stored = (await file.json()) as LegacyConfigShape;
      cache = {
        approvedUsers: stored.approvedUsers ?? [],
        pendingApprovals: stored.pendingApprovals ?? {},
        keys: stored.keys ?? {},
        auxKeys: readAuxKeys(stored),
        emojis: stored.emojis,
        default: stored.default ?? DEFAULT_CONFIG.default,
      };
    } else {
      cache = structuredClone(DEFAULT_CONFIG);
    }
    return cache;
  }

  async function save(): Promise<void> {
    if (!cache) return;
    await Bun.write(paths.configFile, JSON.stringify(cache, null, 2));
  }

  return {
    async getConfig(): Promise<GlobalConfig> {
      return await load();
    },

    async setKey(provider: Provider, key: string): Promise<void> {
      const c = await load();
      c.keys[provider] = key;
      await save();
    },

    async removeKey(provider: Provider): Promise<void> {
      const c = await load();
      delete c.keys[provider];
      await save();
    },

    async setDefault(provider: Provider, model?: string): Promise<void> {
      const c = await load();
      c.default.provider = provider;
      c.default.model = model ?? DEFAULT_MODELS[provider];
      await save();
    },

    async hasAnyKey(): Promise<boolean> {
      const c = await load();
      return Object.values(c.keys).some(Boolean);
    },

    async setAuxKey(name: AuxKey, value: string): Promise<void> {
      const c = await load();
      c.auxKeys[name] = value;
      await save();
    },

    async removeAuxKey(name: AuxKey): Promise<void> {
      const c = await load();
      delete c.auxKeys[name];
      await save();
    },

    async setEmojis(emojis: ToolEmojis): Promise<void> {
      const c = await load();
      c.emojis = emojis;
      await save();
    },

    async clearEmojis(): Promise<void> {
      const c = await load();
      c.emojis = undefined;
      await save();
    },

    async isApproved(userId: number): Promise<boolean> {
      const c = await load();
      return c.approvedUsers.includes(userId);
    },

    async getOrCreatePendingCode(
      userId: number,
      name?: string,
    ): Promise<string> {
      const c = await load();
      pruneExpired(c);
      for (const [code, p] of Object.entries(c.pendingApprovals)) {
        if (p.userId === userId) {
          await save();
          return code;
        }
      }
      const code = generateCode(c.pendingApprovals);
      c.pendingApprovals[code] = { userId, name, createdAt: Date.now() };
      await save();
      return code;
    },

    async approveByCode(code: string): Promise<PendingApproval | null> {
      const c = await load();
      pruneExpired(c);
      const pending = c.pendingApprovals[code];
      if (!pending) {
        await save();
        return null;
      }
      if (!c.approvedUsers.includes(pending.userId)) {
        c.approvedUsers.push(pending.userId);
      }
      delete c.pendingApprovals[code];
      await save();
      return pending;
    },

    async revokeUser(userId: number): Promise<boolean> {
      const c = await load();
      const idx = c.approvedUsers.indexOf(userId);
      if (idx === -1) return false;
      c.approvedUsers.splice(idx, 1);
      await save();
      return true;
    },

    async listApprovedUsers(): Promise<number[]> {
      return [...(await load()).approvedUsers];
    },

    async listPendingApprovals(): Promise<
      Array<PendingApproval & { code: string }>
    > {
      const c = await load();
      pruneExpired(c);
      await save();
      return Object.entries(c.pendingApprovals).map(([code, p]) => ({
        code,
        ...p,
      }));
    },

    async seedFromManager(snapshot: {
      keys: GlobalConfig["keys"];
      auxKeys: GlobalConfig["auxKeys"];
      emojis?: ToolEmojis;
      defaultProvider: Provider;
      defaultModel: string;
    }): Promise<void> {
      const c = await load();
      c.keys = { ...snapshot.keys };
      c.auxKeys = { ...snapshot.auxKeys };
      c.emojis = snapshot.emojis;
      c.default = {
        provider: snapshot.defaultProvider,
        model: snapshot.defaultModel,
      };
      await save();
    },
  };
}

export type ConfigStore = ReturnType<typeof createConfigStore>;
