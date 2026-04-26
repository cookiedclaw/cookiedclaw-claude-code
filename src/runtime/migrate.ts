import { resolve } from "node:path";
import { botPaths, sharedPaths } from "./paths.ts";
import { setManagerBotId, setRegistryOwner } from "./registry.ts";

/**
 * One-shot migration from the pre-multi-bot layout
 * (~/.cookiedclaw/{config.json,sessions.json,chats/,mcp.json}) to the per-bot
 * layout (~/.cookiedclaw/bots/<managerBotId>/...). Idempotent — returns immediately
 * if no old config.json is present.
 */
export async function migrateOldData(managerBotId: number): Promise<void> {
  const oldConfigFile = Bun.file(resolve(sharedPaths.root, "config.json"));
  if (!(await oldConfigFile.exists())) return;

  console.log("[migrate] migrating old data layout to per-bot...");

  const newPaths = botPaths(managerBotId);

  type LegacyConfig = { ownerId?: number; [k: string]: unknown };
  const oldConfig = (await oldConfigFile.json()) as LegacyConfig;

  if (oldConfig.ownerId !== undefined) {
    await setRegistryOwner(oldConfig.ownerId);
  }
  await setManagerBotId(managerBotId);

  const { ownerId: _omit, ...rest } = oldConfig;
  await Bun.write(newPaths.configFile, JSON.stringify(rest, null, 2));
  await oldConfigFile.delete();

  for (const [oldName, newPath] of [
    ["sessions.json", newPaths.sessionsIndex],
    ["mcp.json", newPaths.mcpConfig],
  ] as const) {
    const old = Bun.file(resolve(sharedPaths.root, oldName));
    if (await old.exists()) {
      await Bun.write(newPath, await old.text());
      await old.delete();
    }
  }

  const oldChatsDir = resolve(sharedPaths.root, "chats");
  try {
    const glob = new Bun.Glob("**/*.jsonl");
    for await (const rel of glob.scan({ cwd: oldChatsDir })) {
      const oldPath = resolve(oldChatsDir, rel);
      const newPath = resolve(newPaths.chats, rel);
      await Bun.write(newPath, Bun.file(oldPath));
      await Bun.file(oldPath).delete();
    }
  } catch {
    // old chats dir didn't exist
  }

  console.log(
    `[migrate] done. Data moved to ~/.cookiedclaw/bots/${managerBotId}/`,
  );
}
