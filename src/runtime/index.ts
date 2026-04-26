import type { Skill } from "../skills/loader.ts";
import { createMcpManager } from "../mcp/client.ts";
import { createMcpStore } from "../mcp/store.ts";
import { createChatStore } from "../store/chats.ts";
import { createConfigStore } from "../store/config.ts";
import { createSessionStore } from "../store/sessions.ts";
import { botPaths, type BotPaths } from "./paths.ts";
import { getRegistry } from "./registry.ts";

export type BotRuntime = {
  botId: number;
  paths: BotPaths;
  configStore: ReturnType<typeof createConfigStore>;
  sessionStore: ReturnType<typeof createSessionStore>;
  chatStore: ReturnType<typeof createChatStore>;
  mcpStore: ReturnType<typeof createMcpStore>;
  mcp: ReturnType<typeof createMcpManager>;
  skills: Skill[];
  getOwnerId: () => Promise<number | undefined>;
};

export function createBotRuntime(botId: number, skills: Skill[]): BotRuntime {
  const paths = botPaths(botId);
  const configStore = createConfigStore(paths);
  const sessionStore = createSessionStore(paths);
  const chatStore = createChatStore(paths);
  const mcpStore = createMcpStore(paths);
  const mcp = createMcpManager(mcpStore);

  return {
    botId,
    paths,
    configStore,
    sessionStore,
    chatStore,
    mcpStore,
    mcp,
    skills,
    async getOwnerId() {
      return (await getRegistry()).ownerId;
    },
  };
}
