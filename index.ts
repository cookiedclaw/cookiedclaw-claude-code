import { Bot } from "grammy";
import { OWNER_COMMANDS } from "./src/bot/commands.ts";
import {
  MANAGER_COMMANDS,
  MANAGER_OWNER_HELP,
  registerManagerCommands,
} from "./src/manager/commands.ts";
import { Orchestrator } from "./src/manager/orchestrator.ts";
import { migrateOldData } from "./src/runtime/migrate.ts";
import {
  getRegistry,
  listAgents,
  setManagerInfo,
} from "./src/runtime/registry.ts";
import { loadSkills } from "./src/skills/loader.ts";

const token = Bun.env.TELEGRAM_API_TOKEN;
if (!token) throw new Error("TELEGRAM_API_TOKEN is not set");

// Resolve the manager bot's ID (we need it for the data dir before we start polling).
const probe = new Bot(token);
const me = await probe.api.getMe();
const managerBotId = me.id;
console.log(`[cookiedclaw] manager bot @${me.username} (id ${managerBotId})`);

// One-shot migration from the old single-bot layout.
await migrateOldData(managerBotId);

// Persist manager bot info in registry (idempotent).
const registry = await getRegistry();
const managerUsername = me.username ?? `bot_${managerBotId}`;
if (
  registry.managerBotId !== managerBotId ||
  registry.managerUsername !== managerUsername
) {
  await setManagerInfo(managerBotId, managerUsername);
}

const skills = await loadSkills();
console.log(`[cookiedclaw] loaded ${skills.length} skill(s)`);

const orchestrator = new Orchestrator(skills);

// Start the manager bot first.
const manager = await orchestrator.startBot(token, managerBotId, {
  claimsRegistryOwnership: true,
  ownerExtraHelp: MANAGER_OWNER_HELP,
  configureExtra: (bot, runtime) => {
    registerManagerCommands(bot, runtime, orchestrator);
  },
});
await manager.bot.api.setMyCommands([...OWNER_COMMANDS, ...MANAGER_COMMANDS]);
console.log(`[cookiedclaw] manager started`);

// Start any previously-spawned agents by re-fetching their tokens.
const agents = await listAgents();
for (const agent of agents) {
  if (orchestrator.has(agent.botId)) continue;
  try {
    const tokenRes = (await manager.bot.api.raw.getManagedBotToken({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user_id: agent.botId,
    } as any)) as { token?: string } | string;
    const agentToken =
      typeof tokenRes === "string" ? tokenRes : tokenRes.token ?? "";
    if (!agentToken) {
      console.warn(`[manager] no token for @${agent.username}, skipping`);
      continue;
    }
    const running = await orchestrator.startBot(agentToken, agent.botId);
    await running.bot.api.setMyCommands(OWNER_COMMANDS);
    console.log(`[manager] started @${agent.username}`);
  } catch (err) {
    console.error(`[manager] failed to start @${agent.username}:`, err);
  }
}

// Strip shutdown handlers left over from previous --hot reloads, then attach fresh.
const SHUTDOWN_TAG = Symbol.for("cookiedclaw.shutdown");
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  for (const listener of process.listeners(sig)) {
    if ((listener as unknown as Record<symbol, unknown>)[SHUTDOWN_TAG]) {
      process.removeListener(sig, listener);
    }
  }
}
const shutdown = async () => {
  console.log("[cookiedclaw] shutting down...");
  await orchestrator.stopAll();
  process.exit(0);
};
(shutdown as unknown as Record<symbol, unknown>)[SHUTDOWN_TAG] = true;
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[cookiedclaw] running ${orchestrator.list().length} bot(s)`);
