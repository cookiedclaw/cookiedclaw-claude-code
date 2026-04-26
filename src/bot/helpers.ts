import type { Context } from "grammy";
import type { BotRuntime } from "../runtime/index.ts";
import type { SessionKey } from "../store/types.ts";

export function sessionKeyFromCtx(ctx: Context): SessionKey {
  return { chatId: ctx.chat!.id };
}

export function reply(ctx: Context, text: string): Promise<unknown> {
  return ctx.reply(text, { parse_mode: "Markdown" });
}

export async function ownerOnly(
  ctx: Context,
  runtime: BotRuntime,
): Promise<boolean> {
  const ownerId = await runtime.getOwnerId();
  if (ctx.from?.id !== ownerId) {
    await reply(ctx, "Owner only.");
    return false;
  }
  return true;
}
