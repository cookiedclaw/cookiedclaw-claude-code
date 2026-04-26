import type { BotPaths } from "../runtime/paths.ts";
import type { Provider } from "./config.ts";
import { sessionId, type Session, type SessionKey } from "./types.ts";

type Index = Record<string, Session>;

export function createSessionStore(paths: BotPaths) {
  let cache: Index | null = null;

  async function load(): Promise<Index> {
    if (cache) return cache;
    const file = Bun.file(paths.sessionsIndex);
    cache = (await file.exists()) ? ((await file.json()) as Index) : {};
    return cache;
  }

  async function save(index: Index): Promise<void> {
    await Bun.write(paths.sessionsIndex, JSON.stringify(index, null, 2));
  }

  async function getOrCreate(key: SessionKey): Promise<Session> {
    const index = await load();
    const id = sessionId(key);
    const existing = index[id];
    if (existing) return existing;

    const now = Date.now();
    const session: Session = {
      chatId: key.chatId,
      createdAt: now,
      lastActive: now,
    };
    index[id] = session;
    await save(index);
    return session;
  }

  async function mutate(
    key: SessionKey,
    update: (s: Session) => void,
  ): Promise<Session> {
    const session = await getOrCreate(key);
    update(session);
    const index = await load();
    index[sessionId(key)] = session;
    await save(index);
    return session;
  }

  return {
    getSession: getOrCreate,

    async listSessions(): Promise<Session[]> {
      const index = await load();
      return Object.values(index);
    },

    async updateLastActive(key: SessionKey): Promise<void> {
      await mutate(key, (s) => {
        s.lastActive = Date.now();
      });
    },

    async setSessionProvider(
      key: SessionKey,
      provider: Provider | undefined,
    ): Promise<void> {
      await mutate(key, (s) => {
        s.provider = provider;
        s.model = undefined;
      });
    },

    async setSessionModel(
      key: SessionKey,
      model: string | undefined,
    ): Promise<void> {
      await mutate(key, (s) => {
        s.model = model;
      });
    },

    async setSessionSystemPrompt(
      key: SessionKey,
      systemPrompt: string | undefined,
    ): Promise<void> {
      await mutate(key, (s) => {
        s.systemPromptOverride = systemPrompt;
      });
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
