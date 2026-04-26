import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { wrapLanguageModel, type LanguageModel } from "ai";

/**
 * Wraps a language model with a JSONL request/response logger when the
 * `DEBUG_LLM` env var is truthy. Off by default — zero overhead in
 * production.
 *
 * Each LLM round-trip produces two lines in `<dataDir>/debug-llm.jsonl`
 * (override path with `DEBUG_LLM_FILE`):
 *   { dir: "request",  ts, chatId, provider, model, params: { prompt, tools, toolChoice, ... } }
 *   { dir: "response", ts, chatId, content, finishReason, usage }
 * On thrown errors:
 *   { dir: "error", ts, chatId, error: { name, message } }
 *
 * `params.prompt` is the LanguageModelV2 message array — i.e. the EXACT
 * shape sent to the provider AFTER all SDK conversions (image-data ↔
 * image-url, prompt cache headers, etc.). This is the right place to
 * diagnose "why does Grok reject my call" — the line shows the actual
 * wire payload, not our internal `ModelMessage` shape.
 *
 * Tail it live with: `tail -f ~/.cookiedclaw/bots/<botId>/debug-llm.jsonl | jq .`
 */
export function maybeWrapForDebug(
  model: LanguageModel,
  ctx: {
    botId: number | string;
    chatId: number;
    provider: string;
    modelId: string;
    dataDir: string;
  },
): LanguageModel {
  if (!process.env.DEBUG_LLM || typeof model === "string") return model;

  const file =
    process.env.DEBUG_LLM_FILE ?? resolve(ctx.dataDir, "debug-llm.jsonl");
  const base = {
    botId: ctx.botId,
    chatId: ctx.chatId,
    provider: ctx.provider,
    model: ctx.modelId,
  };

  const append = (entry: Record<string, unknown>): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    // Fire-and-forget — debug logging shouldn't block the agent loop. We
    // log a short stderr note on write failure so a misconfigured path
    // (e.g. read-only dataDir) doesn't silently drop events.
    appendFile(file, line).catch((err) => {
      console.error(`[debug-llm] append failed: ${err}`);
    });
  };

  console.error(`[debug-llm] enabled — logging to ${file}`);

  // The provider factories return LanguageModelV2 or V3 depending on
  // SDK version; `wrapLanguageModel` is typed to V3 but accepts both at
  // runtime. Cast through unknown to silence the structural mismatch.
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate, params }) => {
        append({ ...base, dir: "request", params });
        try {
          const result = await doGenerate();
          append({
            ...base,
            dir: "response",
            content: result.content,
            finishReason: result.finishReason,
            usage: result.usage,
            warnings: result.warnings,
          });
          return result;
        } catch (err) {
          append({
            ...base,
            dir: "error",
            error:
              err instanceof Error
                ? { name: err.name, message: err.message }
                : String(err),
          });
          throw err;
        }
      },
      wrapStream: async ({ doStream, params }) => {
        // We don't currently stream, but middleware must implement both.
        // Pass-through with the same request log so future streaming code
        // gets diagnostics for free.
        append({ ...base, dir: "request", params });
        return doStream();
      },
    },
  });
}
