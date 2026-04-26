import type { Bot, Context } from "grammy";
import type { BotCommand } from "grammy/types";
import Supermemory from "supermemory";
import { ownerOnly, reply } from "../bot/helpers.ts";
import type { BotRuntime } from "../runtime/index.ts";
import {
  addAgent,
  consumePendingSpawn,
  findAgent,
  listAgents,
  removeAgent,
} from "../runtime/registry.ts";
import { createBotRuntime } from "../runtime/index.ts";
import { writeBootstrapFile } from "../runtime/bootstrap.ts";
import type { Orchestrator } from "./orchestrator.ts";

export const MANAGER_OWNER_HELP = `

*Manager only*
\`/spawn <name>\` — get a link to create a new agent bot
\`/agents\` — list spawned agents
\`/destroy <botId>\` — stop and delete an agent`;

export const MANAGER_COMMANDS: BotCommand[] = [
  { command: "spawn", description: "(owner) Create a new agent bot" },
  { command: "agents", description: "(owner) List spawned agents" },
  { command: "destroy", description: "(owner) Destroy an agent" },
];

function suggestUsername(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "agent";
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base}_${rand}_bot`;
}

export function registerManagerCommands(
  bot: Bot,
  manager: BotRuntime,
  orchestrator: Orchestrator,
): void {
  const isOwner = (ctx: Context) => ownerOnly(ctx, manager);

  bot.command("spawn", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const name = (ctx.match ?? "").toString().trim();
    if (!name) {
      await reply(ctx, "Usage: `/spawn <name>`");
      return;
    }
    const me = await ctx.api.getMe();
    const suggested = suggestUsername(name);
    const url = `https://t.me/newbot/${me.username}/${suggested}?name=${encodeURIComponent(name)}`;
    await reply(
      ctx,
      `Tap to create your new agent bot:\n[Create ${name}](${url})\n\nAfter you confirm in Telegram, the bot will appear in /agents and you can DM it.`,
    );
  });

  bot.command("agents", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const agents = await listAgents();
    if (agents.length === 0) {
      await reply(ctx, "No agents yet. Use `/spawn <name>` to create one.");
      return;
    }
    const lines = agents.map(
      (a) =>
        `• \`${a.botId}\` @${a.username} — ${a.name}${
          orchestrator.has(a.botId) ? " 🟢" : " 🔴"
        }`,
    );
    await reply(ctx, `*Agents (${agents.length})*\n${lines.join("\n")}`);
  });

  bot.command("destroy", async (ctx) => {
    if (!(await isOwner(ctx))) return;
    const arg = (ctx.match ?? "").toString().trim();
    const botId = Number.parseInt(arg, 10);
    if (!Number.isFinite(botId)) {
      await reply(ctx, "Usage: `/destroy <botId>`");
      return;
    }
    const agent = await findAgent(botId);
    if (!agent) {
      await reply(ctx, `No agent with id \`${botId}\`.`);
      return;
    }
    await orchestrator.stopBot(botId);
    await removeAgent(botId);
    await reply(
      ctx,
      `Destroyed @${agent.username} (id: \`${botId}\`). Data preserved at \`~/.cookiedclaw/bots/${botId}/\`.`,
    );
  });

  // Telegram managed_bot update — fires when the owner creates a child bot via t.me/newbot/...
  bot.use(async (ctx, next) => {
    const update = ctx.update as unknown as Record<string, unknown>;
    const managedBot = update.managed_bot as
      | { user?: { id: number }; bot?: { id: number; username?: string; first_name?: string } }
      | undefined;
    if (!managedBot?.bot) {
      await next();
      return;
    }
    const ownerId = await manager.getOwnerId();
    if (ownerId === undefined || managedBot.user?.id !== ownerId) {
      console.warn(
        `[manager] non-owner ${managedBot.user?.id} tried to create a managed bot, ignoring`,
      );
      return;
    }

    const newBotId = managedBot.bot.id;
    const newBotUsername = managedBot.bot.username ?? `bot_${newBotId}`;
    const displayName = managedBot.bot.first_name ?? newBotUsername;

    let token: string;
    try {
      const tokenRes = (await ctx.api.raw.getManagedBotToken({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        user_id: newBotId,
      } as any)) as { token?: string } | string;
      token = typeof tokenRes === "string" ? tokenRes : tokenRes.token ?? "";
    } catch (err) {
      console.error("[manager] getManagedBotToken failed:", err);
      return;
    }
    if (!token) {
      console.error("[manager] no token returned for managed bot", newBotId);
      return;
    }

    // Seed new bot from the manager's snapshot
    const newRuntime = createBotRuntime(newBotId, manager.skills);
    const managerCfg = await manager.configStore.getConfig();
    await newRuntime.configStore.seedFromManager({
      keys: managerCfg.keys,
      auxKeys: managerCfg.auxKeys,
      emojis: managerCfg.emojis,
      defaultProvider: managerCfg.default.provider,
      defaultModel: managerCfg.default.model,
    });
    const managerMcp = await manager.mcpStore.read();
    await newRuntime.mcpStore.write(managerMcp);

    // Seed any initial memories into Supermemory under the new bot's container.
    const pendingSpawn = await consumePendingSpawn();
    const memoryKey = managerCfg.auxKeys.memory;
    if (
      pendingSpawn?.initialMemories &&
      pendingSpawn.initialMemories.length > 0 &&
      memoryKey
    ) {
      const client = new Supermemory({ apiKey: memoryKey });
      const tag = `bot_${newBotId}`;
      for (const memory of pendingSpawn.initialMemories) {
        try {
          await client.add({ content: memory, containerTag: tag });
        } catch (err) {
          console.error(
            `[manager] failed to seed memory for @${newBotUsername}:`,
            err,
          );
        }
      }
      console.log(
        `[manager] seeded ${pendingSpawn.initialMemories.length} memories for @${newBotUsername}`,
      );
    }

    await writeBootstrapFile(newBotId);

    await addAgent({
      botId: newBotId,
      username: newBotUsername,
      name: displayName,
      aliases: pendingSpawn?.aliases,
      createdAt: Date.now(),
    });

    try {
      await orchestrator.startBot(token, newBotId);
      await ctx.api.sendMessage(
        ownerId,
        `New agent @${newBotUsername} is live. Open https://t.me/${newBotUsername} to start.`,
      );
    } catch (err) {
      console.error("[manager] failed to start managed bot:", err);
      await ctx.api.sendMessage(
        ownerId,
        `Created @${newBotUsername} but failed to start it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
