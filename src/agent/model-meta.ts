import type { Provider } from "../store/config.ts";

/**
 * Verified context windows (input tokens) for popular models. Most provider
 * APIs don't expose this, so we maintain a small map. Patterns are matched
 * case-insensitively against the resolved model id; first match wins, so
 * longer/more-specific patterns must come BEFORE broader ones.
 *
 * Patterns use `[-.]` instead of `-` so they catch both dot- and hyphen-
 * separated id variants (gateway uses `claude-sonnet-4.6`, direct
 * Anthropic/OpenRouter use `claude-sonnet-4-6`).
 *
 * Sources verified 2026-04-25:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/models/overview
 *   Note: Opus 4.7 uses a new tokenizer and may consume up to ~35% more
 *   tokens for the same text — our chars/4 estimator under-counts there,
 *   which just means we compact slightly earlier (fine).
 *   Note: 1M context for Opus 4.6 / 4.7 / Sonnet 4.6 is the DEFAULT now,
 *   no beta header required (the older context-1m-2025-08-07 beta was
 *   for Sonnet 4 / Opus 4 only and is no longer relevant).
 * - OpenAI: https://developers.openai.com/api/docs/models/gpt-5.4
 *   GPT-5.4 standard window is 272K, API allows up to 1.05M.
 * - Google: https://ai.google.dev/gemini-api/docs/models — all 2.5 models 1M.
 */
const CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  // Anthropic — 1M window models (claude 4.6+ / opus 4.7)
  [/claude-opus-4[-.]7/i, 1_000_000],
  [/claude-opus-4[-.]6/i, 1_000_000],
  [/claude-sonnet-4[-.]6/i, 1_000_000],
  // Anthropic — 200K window (everything else 4.x and 3.x)
  [/claude-(?:opus|sonnet|haiku)-4/i, 200_000],
  [/claude-3/i, 200_000],

  // OpenAI
  [/gpt-5[-.]5/i, 1_000_000],
  [/gpt-5[-.]4/i, 1_050_000],
  [/gpt-5/i, 400_000], // conservative fallback for unspecified 5.x
  [/gpt-4[-.]1/i, 1_000_000],
  [/gpt-4o/i, 128_000],
  [/gpt-4-turbo/i, 128_000],
  [/gpt-4/i, 8_192],
  [/gpt-3\.5/i, 16_384],

  // Google
  [/gemini-2\.5/i, 1_000_000],
  [/gemini-1\.5/i, 1_000_000],

  // Open weights (rough — bumps for 405B / long-context variants)
  [/llama-3\.1-405b/i, 128_000],
  [/llama-3\.1/i, 128_000],
  [/llama-3/i, 8_192],
  [/mistral-large/i, 128_000],
  [/mistral/i, 32_000],
];

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function getContextWindow(_provider: Provider, modelId: string): number {
  for (const [pattern, window] of CONTEXT_WINDOWS) {
    if (pattern.test(modelId)) return window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Whether the model accepts non-text content (image-url, image-data, etc.)
 * inside `role: "tool"` messages. Anthropic, OpenAI, Google extend the
 * spec to allow this; xAI/Grok follow strict OpenAI behavior where
 * tool_result is text-only and reject any other content type.
 *
 * Default: true (most providers we care about support it). False only for
 * known-strict providers — we strip image parts there before sending and
 * the agent loses vision via `read` for that model only.
 */
const TOOL_RESULT_IMAGES_UNSUPPORTED: RegExp[] = [
  /(?:^|\/)(?:x-ai|xai)\b/i, // OpenRouter: x-ai/grok-*, direct xai/grok-*
  /(?:^|\/)grok\b/i,         // bare grok-* model ids
];

export function modelSupportsToolImages(
  _provider: Provider,
  modelId: string,
): boolean {
  return !TOOL_RESULT_IMAGES_UNSUPPORTED.some((p) => p.test(modelId));
}
