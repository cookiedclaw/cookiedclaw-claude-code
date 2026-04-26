import {
  ToolLoopAgent,
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import {
  DEFAULT_MODELS,
  type GlobalConfig,
  type Provider,
} from "../store/config.ts";
import {
  formatSender,
  type Sender,
  type Session,
  type SessionKey,
  type StoredMessage,
} from "../store/types.ts";
import type { BotRuntime } from "../runtime/index.ts";
import { botPaths, userSandboxPath } from "../runtime/paths.ts";
import { withSupermemory } from "@supermemory/tools/ai-sdk";
import { buildAdminTools } from "./admin-tools.ts";
import { maybeWrapForDebug } from "./debug.ts";
import { buildExecTools, detectImageMime } from "./exec-tools.ts";
import { buildImageTools } from "./image-tools.ts";
import { getContextWindow, modelSupportsToolImages } from "./model-meta.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { makeModel } from "./providers.ts";
import { buildSkillTools } from "./tools.ts";
import { abortable } from "./util.ts";
import { buildWebTools } from "./web-tools.ts";

/**
 * Hard step cap per turn. This is a safety brake, not a workflow constraint
 * — we want long-running tasks (iterative debugging, multi-step fal pipelines,
 * search-then-edit-then-verify loops) to finish on their own. Compaction
 * handles context pressure independently. Bumping this is cheap; if a real
 * runaway happens, the user can `/stop`.
 */
const MAX_STEPS = 100;
/**
 * Hard cap per tool call so a hung MCP server (silently-dead transport,
 * subprocess crash, browser automation stuck on a captcha, etc.) can't
 * freeze the whole turn. The agent gets a timeout error back and can
 * recover without the user having to /stop.
 */
const TOOL_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Compaction is token-based, sized to the active model's context window.
 * We approximate tokens as `chars / 4` (good enough for English; under-
 * counts CJK/Russian by ~30%, but compaction is a heuristic — being
 * early-by-a-bit is fine). Swap in a real tokenizer (Anthropic
 * /count_tokens, tiktoken) here if you ever need precision.
 *
 * Trigger compaction at 50% of the window; keep the most-recent
 * 15% (capped) verbatim. So a 200K-context model compacts at 100K and
 * preserves 30K; a 1M-context model compacts at 500K and preserves 50K.
 */
const COMPACT_FRACTION = 0.5;
const KEEP_AFTER_FRACTION = 0.15;
const KEEP_AFTER_CAP = 50_000;
const CHARS_PER_TOKEN = 4;

export type ToolEvent = {
  toolCallId: string;
  name: string;
  args: unknown;
  status: "running" | "done" | "error";
  output?: unknown;
  error?: string;
  /** Short, model-generated description of what this tool call is doing. */
  summary?: string;
  /** Short, model-generated description of the OUTCOME (only set after `done`). */
  resultSummary?: string;
};

export type Attachment =
  | {
      kind: "image";
      data: Uint8Array;
      /** Absolute path where bytes were persisted; used to rebuild this turn from history. */
      path: string;
      mediaType?: string;
    }
  | { kind: "file"; name: string; path: string; mediaType?: string };

export type RespondParams = {
  key: SessionKey;
  sender: Sender;
  userText: string;
  attachments?: Attachment[];
  runtime: BotRuntime;
  abortSignal?: AbortSignal;
  notifyUser?: (userId: number, message: string) => Promise<void>;
  getBotInfo?: () => Promise<{ username: string; canManageBots: boolean }>;
  triggerAgent?: (
    targetBotId: number,
    chatId: number,
    prompt: string,
    abortSignal?: AbortSignal,
    options?: {
      mode?: "delegate" | "notify" | "relay";
      embeds?: string[];
      callerChatId?: number;
    },
  ) => Promise<{
    ok: boolean;
    reply?: string;
    embeds?: string[];
    error?: string;
  }>;
  reloadSkills?: () => Promise<{ count: number; names: string[] }>;
  onProgress?: (events: ToolEvent[]) => void | Promise<void>;
};

/**
 * Inline attachment parsed from a marker in the assistant reply.
 * - `auto` (`[embed:...]`): photos for image MIMEs, document otherwise.
 * - `file` (`[file:...]`): always send as Telegram document — no compression,
 *   preserves original bytes (use when the user wants the raw image file).
 */
export type Embed = { source: string; kind: "auto" | "file" };

export type RespondResult = {
  /** Cleaned reply text (markers stripped). */
  reply: string;
  /** Files / URLs the bot should send as Telegram attachments after the reply. */
  embeds: Embed[];
};

export async function respond(params: RespondParams): Promise<RespondResult> {
  const {
    key,
    sender,
    userText,
    attachments,
    runtime,
    abortSignal,
    notifyUser,
    getBotInfo,
    triggerAgent,
    reloadSkills,
    onProgress,
  } = params;
  const session = await runtime.sessionStore.getSession(key);
  const cfg = await runtime.configStore.getConfig();

  const resolved = resolveProviderAndModel(session, cfg);
  const apiKey = cfg.keys[resolved.provider];
  if (!apiKey) {
    return {
      reply: `No API key for provider \`${resolved.provider}\`. Set one with:\n/setkey ${resolved.provider} <key>`,
      embeds: [],
    };
  }
  const model = makeModel(resolved.provider, resolved.model, apiKey);

  const rawHistory = await runtime.chatStore.readHistory(key);
  // Defensive front-trim: ensure the conversation starts at a user message.
  // (Older entries on disk could begin with a hanging tool/assistant that
  // would otherwise trip Anthropic's "tool_use_id without matching tool_use"
  // check.) User messages are always safe boundaries.
  const firstUserIdx = rawHistory.findIndex((m) => m.message.role === "user");
  let history = firstUserIdx === -1 ? [] : rawHistory.slice(firstUserIdx);

  // Compaction: when history grows past the token threshold, summarize the
  // older portion and persist the summary so future turns start from it
  // (Anthropic prompt caching keys on the stable summary prefix). Walks
  // from the END accumulating tokens until KEEP_AFTER — so a single
  // oversized message can't sneak past the trigger, it just becomes the
  // boundary itself.
  const contextWindow = getContextWindow(resolved.provider, resolved.model);
  const compactThreshold = Math.floor(contextWindow * COMPACT_FRACTION);
  const keepAfter = Math.min(
    Math.floor(contextWindow * KEEP_AFTER_FRACTION),
    KEEP_AFTER_CAP,
  );
  const totalTokens = history.reduce(
    (sum, m) => sum + estimateTokens(m.message),
    0,
  );
  if (totalTokens > compactThreshold) {
    let kept = 0;
    let splitAt = history.length;
    for (let i = history.length - 1; i >= 0; i--) {
      const t = estimateTokens(history[i]!.message);
      if (kept + t > keepAfter && i < history.length - 1) break;
      kept += t;
      splitAt = i;
    }
    if (splitAt > 0) {
      const older = history.slice(0, splitAt);
      const recent = history.slice(splitAt);
      const summary = await summarizeForCompaction({
        model,
        older,
        abortSignal,
      });
      if (summary) {
        await runtime.chatStore.appendCompaction(key, summary);
        history = [
          {
            ts: Date.now(),
            compaction: true as const,
            message: {
              role: "assistant",
              content: `[Summary of earlier conversation] ${summary}`,
            },
          },
          ...recent,
        ];
      }
    }
  }

  const imageAttachments = (attachments ?? []).filter(
    (a): a is Extract<Attachment, { kind: "image" }> => a.kind === "image",
  );

  const userStored: StoredMessage = {
    ts: Date.now(),
    from: sender,
    imagePaths:
      imageAttachments.length > 0
        ? imageAttachments.map((a) => ({
            path: a.path,
            mediaType: a.mediaType,
          }))
        : undefined,
    message: { role: "user", content: userText },
  };
  await runtime.chatStore.appendMessage(key, userStored);

  const prefixedText = `${formatSender(sender)}: ${userText}`;
  // Use `type: "file"` (not `type: "image"`) for image attachments — every
  // major provider's serializer handles `file` with an `image/*` mediaType,
  // but the OpenRouter provider's user-content switch has no `image` case
  // (silently emits empty text), so user-attached photos vanish before
  // reaching xAI/Grok and other OpenRouter-routed models. `file` is the
  // cross-provider safe choice.
  const userMessage: ModelMessage =
    imageAttachments.length > 0
      ? {
          role: "user",
          content: [
            { type: "text", text: prefixedText },
            ...imageAttachments.map((a) => ({
              type: "file" as const,
              data: a.data,
              mediaType: a.mediaType ?? "image/jpeg",
            })),
          ],
        }
      : { role: "user", content: prefixedText };

  const rebuiltHistory = await Promise.all(history.map(toModelMessage));
  const messages: ModelMessage[] = [...rebuiltHistory, userMessage];

  // One cache breakpoint at the very end of the message list. Anthropic caches
  // everything before it — system + tools + history + this turn's input.
  // Other providers ignore providerOptions, so this is a no-op for them.
  applyCacheControl(messages[messages.length - 1]);

  const adminTools = await buildAdminTools({
    key,
    userId: sender.id,
    runtime,
    notifyUser,
    getBotInfo,
    triggerAgent,
    reloadSkills,
  });

  // Per-tool progress events — fired when each tool starts and finishes.
  // Updates merge into the existing event by toolCallId, so a late-arriving
  // model-generated summary doesn't clobber a "done" status.
  const events: ToolEvent[] = [];
  const upsert = (e: { toolCallId: string } & Partial<ToolEvent>) => {
    const idx = events.findIndex((x) => x.toolCallId === e.toolCallId);
    if (idx >= 0) {
      // Existing event already has all required fields; partial updates only
      // overwrite the keys actually present in `e`.
      events[idx] = { ...events[idx], ...e } as ToolEvent;
    } else if (e.name && e.args !== undefined && e.status) {
      // Initial event always carries the full shape; summary-only updates
      // never reach this branch (their toolCallId already exists by then).
      events.push({
        toolCallId: e.toolCallId,
        name: e.name,
        args: e.args,
        status: e.status,
        output: e.output,
        error: e.error,
        summary: e.summary,
        resultSummary: e.resultSummary,
      });
    }
    if (onProgress) void onProgress([...events]);
  };

  const workspace = userSandboxPath(runtime.botId, sender.id);
  const allTools = {
    ...buildSkillTools(runtime.skills),
    ...buildWebTools(cfg.auxKeys.tavily),
    ...buildExecTools({ workspace }),
    ...buildImageTools({
      openaiKey: cfg.keys.openai,
      falKey: cfg.auxKeys.fal,
      workspace,
    }),
    ...adminTools,
    ...runtime.mcp.getTools(),
  };

  const summarize = (toolName: string, args: unknown) =>
    generateToolSummary({
      model,
      userText,
      toolName,
      args,
      abortSignal,
    });
  const summarizeResult = (toolName: string, args: unknown, output: unknown) =>
    generateToolResultSummary({
      model,
      userText,
      toolName,
      args,
      output,
      abortSignal,
    });

  const stripToolImages = !modelSupportsToolImages(
    resolved.provider,
    resolved.model,
  );
  const wrappedTools = wrapToolsWithProgress(
    allTools,
    upsert,
    summarize,
    summarizeResult,
    stripToolImages,
  );

  // Memory: when a Supermemory key is configured, wrap the agent's model
  // with `withSupermemory` so user memories are injected into every LLM call
  // automatically — no `searchMemories` / `addMemory` tool round-trips. The
  // bare `model` stays in scope for compaction + tool summarizers, where
  // memory injection would just burn tokens.
  // The AI SDK's `LanguageModel` union allows raw strings, but Supermemory
  // wants the resolved model object. `makeModel()` always returns the
  // object, so the cast is safe.
  const agentModel = cfg.auxKeys.memory
    ? withSupermemory(model as Exclude<LanguageModel, string>, {
        apiKey: cfg.auxKeys.memory,
        containerTag: `bot_${runtime.botId}`,
        customId: `chat_${key.chatId}`,
        mode: "full",
        addMemory: "always",
      })
    : model;

  // Debug wrapper logs the EXACT wire payload (post-SDK-conversion prompt
  // + tools) and the model's raw response to a JSONL file. Off by default;
  // enable with DEBUG_LLM=1.
  const debugModel = maybeWrapForDebug(agentModel, {
    botId: runtime.botId,
    chatId: key.chatId,
    provider: resolved.provider,
    modelId: resolved.model,
    dataDir: botPaths(runtime.botId).dataDir,
  });

  const agent = new ToolLoopAgent({
    model: debugModel,
    instructions: await buildSystemPrompt(
      runtime.botId,
      session,
      runtime.skills,
    ),
    tools: wrappedTools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  // Collect step messages as they complete so /stop mid-run still persists
  // the tool calls that already finished. Steps fire onStepFinish only after
  // both the LLM call AND its tool executions finish — so collected entries
  // are always matched assistant/tool pairs, no orphan tool_use parts.
  const collected: ModelMessage[] = [];
  let embeds: Embed[] = [];
  let replyForDisplay = "";
  try {
    await agent.generate({
      messages,
      abortSignal,
      onStepFinish: (step) => {
        collected.push(...step.response.messages);
      },
    });
  } finally {
    // Two passes around `[embed:...]`:
    //   1. Pull out the source list AND derive the user-facing reply (markers
    //      stripped completely — user never sees `(sent: ...)`).
    //   2. Rewrite collected[i].content in place so what we PERSIST shows
    //      `(sent: filename)` instead of the marker. That way the model sees
    //      its past sends in history but doesn't re-trigger a duplicate.
    embeds = extractEmbeds(collected);
    replyForDisplay = stripEmbedMarkers(extractReplyText(collected));
    rewriteEmbedsForHistory(collected);

    if (collected.length > 0) {
      const sanitized = collected.map(sanitizeForPersistence);
      await runtime.chatStore.appendModelMessages(key, sanitized);
    }
    // Drop a breadcrumb in chat history so the next turn knows the previous
    // turn was cut short. Persisted as a `user`-role entry with a
    // [system notice] marker — the agent treats it as platform metadata, not
    // something the user typed.
    if (abortSignal?.aborted) {
      await runtime.chatStore.appendMessage(key, {
        ts: Date.now(),
        message: {
          role: "user",
          content:
            "[system notice] You were interrupted by the user via /stop before finishing. Any tool calls above are partial. Wait for the user's next message before continuing.",
        },
      });
    }
    await runtime.sessionStore.updateLastActive(key);
    // NOTE: deliberately not returning from finally — that would swallow the
    // abort/error throw and break /stop. The success-path return is below.
  }

  return { reply: replyForDisplay, embeds };
}

// Matches both `[embed:...]` (auto-detect) and `[file:...]` (force document).
const EMBED_REGEX = /\[(embed|file):([^\]\n]+)\]/g;

/**
 * Pull every `[embed:...]` / `[file:...]` from the LAST assistant message's
 * text parts. Pure read — does not mutate `collected`.
 */
function extractEmbeds(collected: ModelMessage[]): Embed[] {
  const embeds: Embed[] = [];
  for (let i = collected.length - 1; i >= 0; i--) {
    const m = collected[i];
    if (!m || m.role !== "assistant") continue;
    const visit = (text: string) => {
      for (const match of text.matchAll(EMBED_REGEX)) {
        const tag = match[1] === "file" ? "file" : "auto";
        const src = match[2]?.trim();
        if (src) embeds.push({ source: src, kind: tag });
      }
    };
    if (typeof m.content === "string") {
      visit(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") visit(part.text);
      }
    }
    // Only the LAST assistant message owns this turn's embeds.
    break;
  }
  return embeds;
}

/**
 * Replace embed markers in the LAST assistant message with a record
 * note so persisted history shows what was delivered without acting as
 * a re-trigger on future turns.
 *
 * The format is intentionally unmistakable as a history-only annotation
 * (angle brackets + "delivered" verb) — earlier we used `(sent: ...)`
 * which some models (notably Grok) mistook for a valid output format
 * and started emitting literally in their replies, leaking past Telegram
 * dispatch and showing up to the user as plain text.
 */
function rewriteEmbedsForHistory(collected: ModelMessage[]): void {
  for (let i = collected.length - 1; i >= 0; i--) {
    const m = collected[i];
    if (!m || m.role !== "assistant") continue;

    const rewrite = (text: string): string =>
      text.replace(EMBED_REGEX, (_match, _tag: string, src: string) => {
        const trimmed = src.trim();
        const basename = trimmed.split("/").pop() || trimmed;
        return `<delivered: ${basename}>`;
      });

    if (typeof m.content === "string") {
      const after = rewrite(m.content);
      if (after !== m.content) collected[i] = { ...m, content: after };
    } else if (Array.isArray(m.content)) {
      let mutated = false;
      const newContent = m.content.map((part) => {
        if (part.type === "text") {
          const after = rewrite(part.text);
          if (after !== part.text) {
            mutated = true;
            return { ...part, text: after };
          }
        }
        return part;
      });
      if (mutated) collected[i] = { ...m, content: newContent };
    }
    break;
  }
}

// Defensive scrubber for the history-annotation formats the agent might
// echo back into its own reply (the platform won't dispatch from these,
// they'd just leak as literal text). Covers both `<delivered: foo>` (new)
// and `(sent: foo)` (legacy) shapes — old chats still have the latter
// in their stored JSONL.
const HISTORY_ANNOTATION_REGEX =
  /(?:<delivered:\s*[^>\n]+>|\(sent:\s*[^)\n]+\))/g;

function stripEmbedMarkers(text: string): string {
  return text
    .replace(EMBED_REGEX, "")
    .replace(HISTORY_ANNOTATION_REGEX, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

function extractReplyText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      if (m.content.trim()) return m.content;
      continue;
    }
    const text = m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "(no reply)";
}

/**
 * Wrap every tool's `execute` to fire `onChange` once with status="running"
 * before the underlying execute runs, and once with status="done"/"error" after.
 * Lets the UI show in-progress tool calls, not just completed ones.
 */
function wrapToolsWithProgress(
  tools: ToolSet,
  onChange: (event: { toolCallId: string } & Partial<ToolEvent>) => void,
  summarize?: (toolName: string, args: unknown) => Promise<string>,
  summarizeResult?: (
    toolName: string,
    args: unknown,
    output: unknown,
  ) => Promise<string>,
  /** When true, image-data / image-url parts are stripped from tool-result
   *  content before it reaches the model. Required for providers (xAI Grok,
   *  others following strict OpenAI spec) that reject any non-text content
   *  in tool_result. */
  stripToolImages?: boolean,
): ToolSet {
  const wrapped: Record<string, unknown> = {};
  for (const [name, original] of Object.entries(tools)) {
    const t = original as {
      execute?: (
        input: unknown,
        ctx: { toolCallId?: string; abortSignal?: AbortSignal },
      ) => unknown;
      toModelOutput?: (opts: {
        output: unknown;
        toolCallId?: string;
      }) => unknown;
    };
    if (typeof t.execute !== "function") {
      wrapped[name] = original;
      continue;
    }
    const exec = t.execute;
    const origToModelOutput = t.toModelOutput;
    wrapped[name] = {
      ...t,
      // Defensive image-MIME fix: any tool that emits a `content`-typed
      // toModelOutput with image-data parts gets its mediaType corrected
      // against the actual byte signature. Otherwise Anthropic 400s the turn
      // (e.g. when sips writes PNG bytes into a .jpg-named file, or an MCP
      // tool labels everything `image/jpeg` regardless of contents).
      ...(origToModelOutput
        ? {
            toModelOutput: (opts: { output: unknown; toolCallId?: string }) => {
              const result = sanitizeImageMimes(origToModelOutput(opts));
              return stripToolImages ? stripImagesFromContent(result) : result;
            },
          }
        : {}),
      execute: async (
        input: unknown,
        ctx: { toolCallId?: string; abortSignal?: AbortSignal },
      ) => {
        const id =
          ctx?.toolCallId ?? `${name}-${Math.random().toString(36).slice(2)}`;
        onChange({ toolCallId: id, name, args: input, status: "running" });
        // Fire-and-forget: a tiny model call writes a one-line summary into
        // the same event so the Telegram chat shows readable progress.
        if (summarize) {
          summarize(name, input)
            .then((summary) => {
              if (summary) onChange({ toolCallId: id, summary });
            })
            .catch(() => {});
        }
        // Combine the user's /stop signal with a per-call timeout so a
        // wedged MCP RPC (dead transport, stuck child process, etc.) can't
        // hold the turn open indefinitely. Tools that natively honor the
        // signal cancel themselves; for the rest, abortable() unblocks the
        // wait either way.
        const timeoutCtl = new AbortController();
        const timer = setTimeout(
          () =>
            timeoutCtl.abort(
              new Error(
                `tool ${name} exceeded ${TOOL_DEFAULT_TIMEOUT_MS}ms timeout`,
              ),
            ),
          TOOL_DEFAULT_TIMEOUT_MS,
        );
        const combined = ctx?.abortSignal
          ? AbortSignal.any([ctx.abortSignal, timeoutCtl.signal])
          : timeoutCtl.signal;
        try {
          const output = await abortable(
            Promise.resolve(
              exec(input, { ...ctx, abortSignal: combined }) as unknown,
            ),
            combined,
          );
          onChange({
            toolCallId: id,
            name,
            args: input,
            status: "done",
            output,
          });
          // Fire-and-forget result summary so the chat shows what came back.
          if (summarizeResult) {
            summarizeResult(name, input, output)
              .then((rs) => {
                if (rs) onChange({ toolCallId: id, resultSummary: rs });
              })
              .catch(() => {});
          }
          return output;
        } catch (err) {
          onChange({
            toolCallId: id,
            name,
            args: input,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }
  return wrapped as ToolSet;
}

/**
 * Tiny generateText call producing a one-line, present-tense description of
 * what a tool call is doing right now. Runs in parallel with the tool's
 * execute so it doesn't block; the summary is delivered later via onChange
 * and may arrive after the tool finishes (which is fine — we merge by id).
 */
async function generateToolSummary(opts: {
  model: LanguageModel;
  userText: string;
  toolName: string;
  args: unknown;
  abortSignal?: AbortSignal;
}): Promise<string> {
  try {
    const argsJson = JSON.stringify(opts.args ?? {}).slice(0, 600);
    const { text } = await generateText({
      model: opts.model,
      prompt: `User's last message (mirror its language in your output):
"""
${opts.userText.slice(0, 400)}
"""

The agent is calling tool \`${opts.toolName}\` with these args:
${argsJson}

Write ONE short sentence (max 8 words) describing what the agent is doing right now, in the user's language. No quotes, no labels, no trailing period unless natural. Examples: "Reading the config file", "Ищу в памяти про тренировки", "Generating an image of a sunset".`,
      maxOutputTokens: 30,
      abortSignal: opts.abortSignal,
    });
    return text.trim().replace(/^["'`]+|["'`]+$/g, "");
  } catch {
    return "";
  }
}

/**
 * Tiny generateText call producing a one-line, past-tense description of
 * what a tool call RETURNED. Mirrors generateToolSummary but runs after
 * the tool finishes and looks at the output.
 */
async function generateToolResultSummary(opts: {
  model: LanguageModel;
  userText: string;
  toolName: string;
  args: unknown;
  output: unknown;
  abortSignal?: AbortSignal;
}): Promise<string> {
  try {
    const argsJson = JSON.stringify(opts.args ?? {}).slice(0, 400);
    const outputJson =
      typeof opts.output === "string"
        ? opts.output
        : JSON.stringify(opts.output ?? {});
    const outputTrunc = outputJson.slice(0, 1500);
    const { text } = await generateText({
      model: opts.model,
      prompt: `User's last message (mirror its language in your output):
"""
${opts.userText.slice(0, 400)}
"""

The agent just finished tool \`${opts.toolName}\`.
Args: ${argsJson}
Output: ${outputTrunc}

Write ONE short phrase (max 8 words) describing the OUTCOME of this call, in the user's language. No quotes, no labels, no trailing period unless natural. Examples in English: "Found 12 results", "Saved to memory", "Image generated", "File not found", "Empty response", "ok". Translate to the user's language.`,
      maxOutputTokens: 30,
      abortSignal: opts.abortSignal,
    });
    return text.trim().replace(/^["'`]+|["'`]+$/g, "");
  } catch {
    return "";
  }
}

/**
 * Approximate token count for a message. JSON.stringify covers tool calls
 * + tool results too, since those round-trip through the same shape we
 * send to the model. Off by ~10-30% depending on language; good enough
 * for "should we compact" decisions.
 */
function estimateTokens(message: ModelMessage): number {
  return Math.ceil(JSON.stringify(message).length / CHARS_PER_TOKEN);
}

/**
 * Summarize an older portion of conversation history into a single
 * paragraph that preserves task, decisions, identifiers, and unfinished
 * work — drops the moment-to-moment tool back-and-forth.
 */
async function summarizeForCompaction(opts: {
  model: LanguageModel;
  older: StoredMessage[];
  /** Free-form additional instructions appended to the summarizer prompt. */
  extraInstructions?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  if (opts.older.length === 0) return "";
  const transcript = opts.older
    .map((m) => renderForCompaction(m.message))
    .join("\n")
    .slice(0, 60_000);
  const extra = opts.extraInstructions?.trim()
    ? `\n\nADDITIONAL USER INSTRUCTIONS for this compaction (highest priority — follow them on top of the rules above):\n${opts.extraInstructions.trim()}`
    : "";
  try {
    const { text } = await generateText({
      model: opts.model,
      prompt: `You are compacting an old conversation between a user and an AI assistant so it fits in the context window. Preserve:
- the user's overall task and goals
- decisions made by the user or assistant
- files, paths, identifiers, names referenced
- action items, current state, anything unfinished
- the user's stated preferences (language, tone, etc.)

Drop:
- the back-and-forth of tool calls and exploration
- redundant questions and acknowledgments
- raw tool outputs (just say what was learned)

Output ONE concise paragraph (max ~250 words). Match the user's language. Do not include a "Summary:" label.${extra}

<conversation>
${transcript}
</conversation>`,
      maxOutputTokens: 600,
      abortSignal: opts.abortSignal,
    });
    return text.trim();
  } catch {
    return "";
  }
}

/**
 * Context breakdown — used by the /context slash command. Mirrors the same
 * builders respond() uses so the numbers reflect what would actually be
 * sent to the model on the next turn.
 */
export type ContextBreakdown = {
  provider: string;
  model: string;
  contextWindow: number;
  compactAt: number;
  keepAfter: number;
  systemTokens: number;
  toolsTokens: number;
  toolsCount: number;
  historyTokens: number;
  totalTokens: number;
  history: {
    total: number;
    user: { count: number; tokens: number };
    assistant: { count: number; tokens: number };
    tool: { count: number; tokens: number };
    compaction: { count: number; tokens: number };
  };
};

export async function buildContextBreakdown(params: {
  key: SessionKey;
  userId: number;
  runtime: BotRuntime;
}): Promise<ContextBreakdown> {
  const { key, userId, runtime } = params;
  const cfg = await runtime.configStore.getConfig();
  const session = await runtime.sessionStore.getSession(key);
  const resolved = resolveProviderAndModel(session, cfg);
  const contextWindow = getContextWindow(resolved.provider, resolved.model);
  const compactAt = Math.floor(contextWindow * COMPACT_FRACTION);
  const keepAfter = Math.min(
    Math.floor(contextWindow * KEEP_AFTER_FRACTION),
    KEEP_AFTER_CAP,
  );

  const systemPrompt = await buildSystemPrompt(
    runtime.botId,
    session,
    runtime.skills,
  );
  const systemTokens = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);

  const adminTools = await buildAdminTools({ key, userId, runtime });
  const sandbox = userSandboxPath(runtime.botId, userId);
  const allTools = {
    ...buildSkillTools(runtime.skills),
    ...buildWebTools(cfg.auxKeys.tavily),
    ...buildExecTools({ workspace: sandbox }),
    ...buildImageTools({
      openaiKey: cfg.keys.openai,
      falKey: cfg.auxKeys.fal,
      workspace: sandbox,
    }),
    ...adminTools,
    ...runtime.mcp.getTools(),
  };
  const toolsTokens = Math.ceil(
    JSON.stringify(allTools).length / CHARS_PER_TOKEN,
  );
  const toolsCount = Object.keys(allTools).length;

  const rawHistory = await runtime.chatStore.readHistory(key);
  const firstUserIdx = rawHistory.findIndex((m) => m.message.role === "user");
  const usable = firstUserIdx === -1 ? [] : rawHistory.slice(firstUserIdx);

  const buckets = {
    user: { count: 0, tokens: 0 },
    assistant: { count: 0, tokens: 0 },
    tool: { count: 0, tokens: 0 },
    compaction: { count: 0, tokens: 0 },
  };
  for (const m of usable) {
    const t = estimateTokens(m.message);
    if (m.compaction) {
      buckets.compaction.count++;
      buckets.compaction.tokens += t;
    } else if (m.message.role === "user") {
      buckets.user.count++;
      buckets.user.tokens += t;
    } else if (m.message.role === "assistant") {
      buckets.assistant.count++;
      buckets.assistant.tokens += t;
    } else if (m.message.role === "tool") {
      buckets.tool.count++;
      buckets.tool.tokens += t;
    }
  }
  const historyTokens =
    buckets.user.tokens +
    buckets.assistant.tokens +
    buckets.tool.tokens +
    buckets.compaction.tokens;
  const totalTokens = systemTokens + toolsTokens + historyTokens;

  return {
    provider: resolved.provider,
    model: resolved.model,
    contextWindow,
    compactAt,
    keepAfter,
    systemTokens,
    toolsTokens,
    toolsCount,
    historyTokens,
    totalTokens,
    history: { total: usable.length, ...buckets },
  };
}

/**
 * Manual compaction entry point — used by the /compact slash command. Reads
 * the chat's full history, summarizes it (optionally with extra
 * instructions), and persists the summary so the next agent turn picks it
 * up automatically.
 */
export async function compactNow(params: {
  key: SessionKey;
  runtime: BotRuntime;
  extraInstructions?: string;
  abortSignal?: AbortSignal;
}): Promise<{
  ok: boolean;
  summary?: string;
  messagesCompacted?: number;
  error?: string;
}> {
  const { key, runtime, extraInstructions, abortSignal } = params;
  const cfg = await runtime.configStore.getConfig();
  const session = await runtime.sessionStore.getSession(key);
  const resolved = resolveProviderAndModel(session, cfg);
  const apiKey = cfg.keys[resolved.provider];
  if (!apiKey) {
    return {
      ok: false,
      error: `No API key for provider ${resolved.provider}`,
    };
  }
  const model = makeModel(resolved.provider, resolved.model, apiKey);

  const rawHistory = await runtime.chatStore.readHistory(key);
  const firstUserIdx = rawHistory.findIndex((m) => m.message.role === "user");
  const history = firstUserIdx === -1 ? [] : rawHistory.slice(firstUserIdx);
  if (history.length === 0) {
    return { ok: false, error: "No history to compact" };
  }

  const summary = await summarizeForCompaction({
    model,
    older: history,
    extraInstructions,
    abortSignal,
  });
  if (!summary) {
    return { ok: false, error: "Failed to generate summary" };
  }
  await runtime.chatStore.appendCompaction(key, summary);
  return { ok: true, summary, messagesCompacted: history.length };
}

function renderForCompaction(message: ModelMessage): string {
  const role = message.role;
  if (typeof message.content === "string") {
    return `[${role}] ${message.content}`;
  }
  const parts: string[] = [];
  for (const p of message.content as Array<
    { type: string } & Record<string, unknown>
  >) {
    if (p.type === "text") {
      parts.push(String(p.text));
    } else if (p.type === "tool-call") {
      const argsStr = JSON.stringify(p.input ?? {}).slice(0, 200);
      parts.push(`[call ${String(p.toolName)}(${argsStr})]`);
    } else if (p.type === "tool-result") {
      const o = p.output as { type: string } & Record<string, unknown>;
      let text: string;
      if (o.type === "text" || o.type === "error-text") {
        text = String(o.value);
      } else if (o.type === "json" || o.type === "error-json") {
        text = JSON.stringify(o.value).slice(0, 300);
      } else if (o.type === "content" && Array.isArray(o.value)) {
        text = (o.value as Array<{ type: string; text?: string }>)
          .filter((x) => x.type === "text" && typeof x.text === "string")
          .map((x) => x.text!)
          .join(" ")
          .slice(0, 300);
      } else {
        text = "[non-text]";
      }
      parts.push(`[result ${String(p.toolName)}: ${text}]`);
    } else if (p.type === "image") {
      parts.push("[image]");
    } else if (p.type === "file") {
      parts.push("[file]");
    } else if (p.type === "reasoning") {
      // Skip reasoning blocks — they're noise for compaction.
    }
  }
  return `[${role}] ${parts.join(" ")}`;
}

/**
 * Walk a tool's `toModelOutput` result and rewrite the `mediaType` of any
 * image-data / file-data part to match its actual byte signature. Some
 * tools lie about MIME (filename-based detection) and Anthropic strictly
 * rejects mismatches with a 400. Pure best-effort: unrecognized formats
 * pass through unchanged.
 */
function sanitizeImageMimes(result: unknown): unknown {
  if (
    !result ||
    typeof result !== "object" ||
    (result as { type?: string }).type !== "content"
  ) {
    return result;
  }
  const value = (result as { value?: unknown }).value;
  if (!Array.isArray(value)) return result;
  let mutated = false;
  const newValue = value.map((part) => {
    if (!part || typeof part !== "object") return part;

    // image-data / file-data: base64 in `data` field, mediaType separate.
    if (part.type === "image-data" || part.type === "file-data") {
      const data = (part as { data?: unknown }).data;
      if (typeof data !== "string") return part;
      try {
        const bytes = Buffer.from(data, "base64");
        const realMime = detectImageMime(
          new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        );
        if (
          realMime &&
          realMime !== (part as { mediaType?: string }).mediaType
        ) {
          mutated = true;
          return { ...part, mediaType: realMime };
        }
      } catch {
        // bad base64 — let downstream complain
      }
      return part;
    }

    // image-url with a data URL: rewrite the embedded MIME if it mismatches
    // the actual bytes (e.g. PNG bytes in `data:image/jpeg;base64,...`).
    if (part.type === "image-url" || part.type === "file-url") {
      const url = (part as { url?: unknown }).url;
      if (typeof url !== "string") return part;
      const m = url.match(/^data:([^;]+);base64,(.+)$/i);
      if (!m || !m[1] || !m[2]) return part;
      const declaredMime = m[1];
      const data = m[2];
      try {
        const bytes = Buffer.from(data, "base64");
        const realMime = detectImageMime(
          new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        );
        if (realMime && realMime !== declaredMime) {
          mutated = true;
          return { ...part, url: `data:${realMime};base64,${data}` };
        }
      } catch {
        // bad base64 — let downstream complain
      }
      return part;
    }

    return part;
  });
  return mutated ? { ...(result as object), value: newValue } : result;
}

/**
 * Drop image / file content parts from a tool's `toModelOutput` result.
 * Used for providers that reject non-text content in tool_result (xAI Grok
 * via OpenRouter being the canonical example — they follow strict OpenAI
 * spec where tool_result is text-only).
 *
 * The text parts (caption etc.) survive; the model still sees that an
 * image was read, just no longer the pixels. For vision on those models,
 * users should upload images directly via Telegram (user-content image,
 * widely supported).
 */
function stripImagesFromContent(result: unknown): unknown {
  if (
    !result ||
    typeof result !== "object" ||
    (result as { type?: string }).type !== "content"
  ) {
    return result;
  }
  const value = (result as { value?: unknown }).value;
  if (!Array.isArray(value)) return result;
  const filtered = value.filter((part) => {
    if (!part || typeof part !== "object") return true;
    const t = (part as { type?: string }).type;
    return (
      t !== "image-data" &&
      t !== "image-url" &&
      t !== "file-data" &&
      t !== "file-url" &&
      t !== "image-file-id"
    );
  });
  if (filtered.length === value.length) return result;
  // If nothing's left, fall back to a single placeholder text so the model
  // still sees something useful.
  if (filtered.length === 0) {
    return {
      type: "text" as const,
      value:
        "(image/file content omitted — this model doesn't support attachments in tool results)",
    };
  }
  return { ...(result as object), value: filtered };
}

/**
 * Replace `content`-type tool-result outputs (image/file parts) with their
 * text content before persisting. Vision payloads aren't useful across
 * turns: image-data URLs from gen tools are signed and expire, raw base64
 * bytes bloat the JSONL forever. Plain text/json outputs go through
 * untouched — compaction handles overall history size, not this layer.
 */
function sanitizeForPersistence(message: ModelMessage): ModelMessage {
  if (message.role !== "tool") return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const output = part.output;
      if (output.type !== "content") return part;
      const text = output.value
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      return {
        ...part,
        output: {
          type: "text" as const,
          value: text || "(image/file output elided from history)",
        },
      };
    }),
  };
}

function applyCacheControl(message: ModelMessage | undefined): void {
  if (!message) return;
  const opts = { anthropic: { cacheControl: { type: "ephemeral" } } };
  if (typeof message.content === "string") {
    (message as { content: unknown }).content = [
      { type: "text", text: message.content, providerOptions: opts },
    ];
    return;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const last = message.content[message.content.length - 1] as {
    providerOptions?: Record<string, unknown>;
  };
  last.providerOptions = { ...(last.providerOptions ?? {}), ...opts };
}

function resolveProviderAndModel(
  session: Session,
  cfg: GlobalConfig,
): { provider: Provider; model: string } {
  if (session.provider) {
    return {
      provider: session.provider,
      model: session.model ?? DEFAULT_MODELS[session.provider],
    };
  }
  return {
    provider: cfg.default.provider,
    model: session.model ?? cfg.default.model,
  };
}

async function toModelMessage(m: StoredMessage): Promise<ModelMessage> {
  // Assistant + tool messages persist verbatim — tool calls and tool results
  // already match the AI SDK shape and round-trip cleanly. Sanitize defensively
  // so any pre-fix entries with file-url parts can't trigger the Anthropic
  // download-file 400 on every subsequent turn.
  if (m.message.role !== "user") return sanitizeForPersistence(m.message);

  // User messages: re-derive the [Sender] prefix and reattach image bytes
  // from the disk paths in the side-table (we never persist Uint8Arrays).
  const baseText =
    typeof m.message.content === "string"
      ? m.message.content
      : (m.message.content.find(
          (p): p is { type: "text"; text: string } => p.type === "text",
        )?.text ?? "");
  const prefix = m.from ? `${formatSender(m.from)}: ` : "";
  const text = prefix + baseText;

  const images = m.imagePaths ?? [];
  if (images.length === 0) return { role: "user", content: text };

  const parts: Array<
    | { type: "text"; text: string }
    | { type: "file"; data: Uint8Array; mediaType: string }
  > = [{ type: "text", text }];
  for (const img of images) {
    try {
      const file = Bun.file(img.path);
      if (!(await file.exists())) continue;
      const data = new Uint8Array(await file.arrayBuffer());
      parts.push({
        type: "file",
        data,
        mediaType: img.mediaType ?? "image/jpeg",
      });
    } catch (err) {
      console.warn(`[history] image read failed: ${img.path}`, err);
    }
  }
  return { role: "user", content: parts };
}
