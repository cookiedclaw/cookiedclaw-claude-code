import { sharedPaths } from "./paths.ts";

export type AgentEntry = {
  botId: number;
  username: string;
  /** Bot's display name from BotFather (e.g. "Beatforge"). */
  name: string;
  /**
   * Other names the agent answers to — typically the persona's name
   * recorded into initial_memories at spawn time (e.g. "Саня"). Useful
   * for disambiguation when the owner refers to the agent by its persona
   * rather than the bot's display name.
   */
  aliases?: string[];
  createdAt: number;
};

export type PendingSpawn = {
  name: string;
  initialMemories?: string[];
  aliases?: string[];
  createdAt: number;
};

export type Registry = {
  ownerId?: number;
  managerBotId?: number;
  managerUsername?: string;
  agents: AgentEntry[];
  pendingSpawn?: PendingSpawn;
};

const PENDING_SPAWN_TTL_MS = 30 * 60 * 1000;

const DEFAULT: Registry = { agents: [] };

let cache: Registry | null = null;

async function load(): Promise<Registry> {
  if (cache) return cache;
  const file = Bun.file(sharedPaths.registry);
  if (await file.exists()) {
    const stored = (await file.json()) as Partial<Registry>;
    cache = {
      ownerId: stored.ownerId,
      managerBotId: stored.managerBotId,
      managerUsername: stored.managerUsername,
      agents: stored.agents ?? [],
      pendingSpawn: stored.pendingSpawn,
    };
  } else {
    cache = structuredClone(DEFAULT);
  }
  return cache;
}

async function save(): Promise<void> {
  if (!cache) return;
  await Bun.write(sharedPaths.registry, JSON.stringify(cache, null, 2));
}

export async function getRegistry(): Promise<Registry> {
  return await load();
}

export async function setManagerBotId(botId: number): Promise<void> {
  const r = await load();
  r.managerBotId = botId;
  await save();
}

export async function setManagerInfo(
  botId: number,
  username: string,
): Promise<void> {
  const r = await load();
  r.managerBotId = botId;
  r.managerUsername = username;
  await save();
}

export async function setRegistryOwner(userId: number): Promise<void> {
  const r = await load();
  r.ownerId = userId;
  await save();
}

export async function addAgent(entry: AgentEntry): Promise<void> {
  const r = await load();
  if (r.agents.some((a) => a.botId === entry.botId)) return;
  r.agents.push(entry);
  await save();
}

export async function removeAgent(botId: number): Promise<boolean> {
  const r = await load();
  const idx = r.agents.findIndex((a) => a.botId === botId);
  if (idx === -1) return false;
  r.agents.splice(idx, 1);
  await save();
  return true;
}

export async function listAgents(): Promise<AgentEntry[]> {
  return [...(await load()).agents];
}

export async function findAgent(botId: number): Promise<AgentEntry | undefined> {
  const r = await load();
  return r.agents.find((a) => a.botId === botId);
}

export async function setPendingSpawn(
  name: string,
  options: { initialMemories?: string[]; aliases?: string[] },
): Promise<void> {
  const r = await load();
  r.pendingSpawn = {
    name,
    initialMemories: options.initialMemories,
    aliases: options.aliases,
    createdAt: Date.now(),
  };
  await save();
}

export async function consumePendingSpawn(): Promise<PendingSpawn | null> {
  const r = await load();
  const pending = r.pendingSpawn;
  if (!pending) return null;
  r.pendingSpawn = undefined;
  await save();
  if (Date.now() - pending.createdAt > PENDING_SPAWN_TTL_MS) return null;
  return pending;
}
