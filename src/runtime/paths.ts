import { homedir } from "node:os";
import { resolve } from "node:path";

export const ROOT = resolve(homedir(), ".cookiedclaw");

export type BotPaths = {
  dataDir: string;
  configFile: string;
  sessionsIndex: string;
  chats: string;
  mcpConfig: string;
  bootstrapFile: string;
};

export function botPaths(botId: number | string): BotPaths {
  const dataDir = resolve(ROOT, "bots", String(botId));
  return {
    dataDir,
    configFile: resolve(dataDir, "config.json"),
    sessionsIndex: resolve(dataDir, "sessions.json"),
    chats: resolve(dataDir, "chats"),
    mcpConfig: resolve(dataDir, "mcp.json"),
    bootstrapFile: resolve(dataDir, "BOOTSTRAP.md"),
  };
}

export const sharedPaths = {
  root: ROOT,
  registry: resolve(ROOT, "registry.json"),
  skills: resolve(ROOT, "skills"),
};

/** Per-(bot, user) sandbox directory for filesystem + shell tools. */
export function userSandboxPath(
  botId: number | string,
  userId: number | string,
): string {
  return resolve(ROOT, "bots", String(botId), "sandboxes", String(userId));
}
