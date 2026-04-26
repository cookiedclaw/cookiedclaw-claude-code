import { createGateway } from "ai";
import { abortable } from "./util.ts";
import type { GlobalConfig, Provider } from "../store/config.ts";

export type ListedModel = {
  /** Full model id as accepted by the provider's API. */
  id: string;
  /** Optional human-readable name (gateway exposes this; direct providers don't). */
  name?: string;
};

export type FetchModelsResult =
  | { ok: true; provider: Provider; models: ListedModel[] }
  | { ok: false; provider: Provider; error: string };

/**
 * Fetch the list of available models for a provider, live, from its API.
 * Used by the `list_models` admin tool and by the `/model` / `/setdefault`
 * pickers in the bot UI. We deliberately don't cache here — pickers wrap
 * this in a TTL cache (slash-command UX), and tool calls happen rarely
 * enough that a fresh fetch is fine.
 */
export async function fetchAvailableModels(
  provider: Provider,
  cfg: GlobalConfig,
  signal?: AbortSignal,
): Promise<FetchModelsResult> {
  try {
    if (provider === "gateway") {
      if (!cfg.keys.gateway) {
        return { ok: false, provider, error: "No gateway key set." };
      }
      const gw = createGateway({ apiKey: cfg.keys.gateway });
      const { models } = await abortable(gw.getAvailableModels(), signal);
      return {
        ok: true,
        provider,
        models: models.map((m) => ({
          id: m.id,
          name: (m as { name?: string }).name,
        })),
      };
    }

    const headers: Record<string, string> = {};
    let url: string;
    switch (provider) {
      case "anthropic":
        if (!cfg.keys.anthropic) {
          return { ok: false, provider, error: "No anthropic key set." };
        }
        url = "https://api.anthropic.com/v1/models";
        headers["x-api-key"] = cfg.keys.anthropic;
        headers["anthropic-version"] = "2023-06-01";
        break;
      case "openai":
        if (!cfg.keys.openai) {
          return { ok: false, provider, error: "No openai key set." };
        }
        url = "https://api.openai.com/v1/models";
        headers["Authorization"] = `Bearer ${cfg.keys.openai}`;
        break;
      case "openrouter":
        if (!cfg.keys.openrouter) {
          return { ok: false, provider, error: "No openrouter key set." };
        }
        url = "https://openrouter.ai/api/v1/models";
        headers["Authorization"] = `Bearer ${cfg.keys.openrouter}`;
        break;
      default:
        return { ok: false, provider, error: `Unknown provider: ${provider}` };
    }

    const res = await fetch(url, { headers, signal });
    if (!res.ok) {
      return {
        ok: false,
        provider,
        error: `HTTP ${res.status} from ${provider}`,
      };
    }
    const data = (await res.json()) as {
      data?: Array<{ id?: string; name?: string }>;
    };
    const models = (data.data ?? [])
      .filter((m): m is { id: string; name?: string } => Boolean(m.id))
      .map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }));
    return { ok: true, provider, models };
  } catch (err) {
    return {
      ok: false,
      provider,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Filter a raw model list down to the ones that make sense in a picker UI.
 * Provider APIs return everything (including legacy 3.5/4 era models, fine-
 * tuned variants, embeddings, audio, image gen models, ...) — we only want
 * the current top-tier conversational models.
 *
 * Heuristic: match against known "interesting" family patterns. The patterns
 * are intentionally permissive on version numbers so newer releases auto-
 * appear without code changes.
 */
const PICK_PATTERNS: RegExp[] = [
  // Anthropic Claude (modern naming: claude-{opus,sonnet,haiku}-N[-N])
  /(?:^|\/)claude-(?:opus|sonnet|haiku)-\d/i,
  // OpenAI GPT-4.1 / 5.x and beyond
  /(?:^|\/)gpt-(?:[5-9]|4\.1|4o)/i,
  // Google Gemini 2.x and beyond (1.5 era is dropped)
  /(?:^|\/)gemini-[2-9]/i,
  // Google Gemma 2+ (open-weights, served via gateway/openrouter).
  // Match `gemma-N-` so first-gen `gemma-7b` (no version) is excluded.
  /(?:^|\/)gemma-[2-9]-/i,
  // DeepSeek — chat / r1 / v3 / coder, all variants
  /(?:^|\/)deepseek[-/]/i,
  // xAI Grok 2+ (across direct / openrouter / gateway prefixes)
  /(?:^|\/)grok-[2-9]/i,
];

const SKIP_PATTERNS: RegExp[] = [
  // Embeddings, audio, image, moderation — not chat models
  /embedding|whisper|tts|dall-e|moderation|image|vision-preview|search/i,
  // Snapshots / pinned dates — keep the floating alias only
  /\d{4}-\d{2}-\d{2}/,
  // Cheap / preview / experimental variants we don't curate
  /preview|nano|mini-realtime|realtime/i,
];

/** Pretty label from an id like `anthropic/claude-sonnet-4.6` → `Claude Sonnet 4.6`. */
export function modelLabel(m: ListedModel): string {
  if (m.name) return m.name;
  const tail = m.id.includes("/") ? m.id.split("/").slice(-1)[0]! : m.id;
  // claude-sonnet-4-6 → Claude Sonnet 4.6
  // gpt-5.4 → GPT-5.4
  // gemini-2.5-pro → Gemini 2.5 Pro
  return tail
    .replace(/-(\d)-(\d)/g, "-$1.$2")
    .split("-")
    .map((part) => {
      if (/^gpt/i.test(part)) return part.toUpperCase();
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function pickRecommendedModels(
  models: ListedModel[],
  limit = 16,
): ListedModel[] {
  const seen = new Set<string>();
  const filtered = models.filter((m) => {
    if (seen.has(m.id)) return false;
    if (SKIP_PATTERNS.some((p) => p.test(m.id))) return false;
    if (!PICK_PATTERNS.some((p) => p.test(m.id))) return false;
    seen.add(m.id);
    return true;
  });
  // Reverse-alpha: newest version numbers tend to sort to the top this way
  // (claude-...-4-7 > claude-...-4-6 > claude-...-3-5).
  filtered.sort((a, b) => b.id.localeCompare(a.id));
  return filtered.slice(0, limit);
}
