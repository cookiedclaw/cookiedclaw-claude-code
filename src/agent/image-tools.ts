import { resolve } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { createFalClient } from "@fal-ai/client";
import { generateImage, tool, type ToolSet } from "ai";
import { z } from "zod";
import { loadBytesFromSource } from "./util.ts";

function fileExtFromMediaType(mediaType: string | undefined): string {
  return (mediaType?.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "");
}

/**
 * Verbose dump of an SDK / fetch error for logs *and* tool results. fal's
 * client (and OpenAI's, and most fetch wrappers) stash the actual JSON
 * body / status on the exception — `err.message` alone usually says only
 * "Validation error" or "Forbidden", which the agent can't act on. We
 * surface every commonly-populated field so the model sees the real
 * server-side complaint and can self-correct (e.g. fix the `input` shape
 * for the next `fal_run` retry).
 */
function describeApiError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    status?: number;
    code?: string | number;
    body?: unknown;
    response?: {
      status?: number;
      statusText?: string;
      data?: unknown;
    };
    cause?: unknown;
  };
  const parts: string[] = [e.message || e.name || "Error"];
  const status = e.status ?? e.response?.status;
  if (status) parts.push(`status=${status}`);
  if (e.code !== undefined) parts.push(`code=${e.code}`);
  const body = e.body ?? e.response?.data;
  if (body !== undefined) {
    let s: string;
    try {
      s = typeof body === "string" ? body : JSON.stringify(body);
    } catch {
      s = String(body);
    }
    parts.push(`body=${s.length > 1500 ? s.slice(0, 1500) + "…" : s}`);
  }
  if (e.cause) {
    parts.push(
      `cause=${e.cause instanceof Error ? e.cause.message : String(e.cause)}`,
    );
  }
  return parts.join(" | ");
}

/**
 * Inline-resolve `$ref` pointers inside an OpenAPI document. fal.ai's
 * model registry returns schemas like `{ "$ref": "#/components/schemas/X" }`
 * which Google's Gemini API rejects when echoed back inside a
 * function_response (it tries to match the ref string against display_names
 * in the message parts and 400s). Resolving server-side gives every
 * provider a self-contained schema. Depth-limited and cycle-guarded so
 * recursive schemas don't blow up.
 */
function resolveOpenApiRefs(doc: unknown): unknown {
  if (!doc || typeof doc !== "object") return doc;
  const root = doc as { components?: { schemas?: Record<string, unknown> } };
  const schemas = root.components?.schemas ?? {};
  const MAX_DEPTH = 8;
  const visit = (node: unknown, seen: Set<string>, depth: number): unknown => {
    if (!node || typeof node !== "object") return node;
    if (depth > MAX_DEPTH) return { _truncated: "max ref depth" };
    if (Array.isArray(node)) return node.map((n) => visit(n, seen, depth));
    const obj = node as Record<string, unknown>;
    const ref = obj["$ref"];
    if (typeof ref === "string") {
      if (seen.has(ref)) return { _cycle: ref };
      const m = ref.match(/^#\/components\/schemas\/(.+)$/);
      if (!m) return { _unresolved: ref };
      const target = schemas[m[1]!];
      if (target === undefined) return { _unresolved: ref };
      const next = new Set(seen);
      next.add(ref);
      return visit(target, next, depth + 1);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = visit(v, seen, depth);
    }
    return out;
  };
  const resolved = visit(doc, new Set(), 0) as Record<string, unknown>;
  // Drop components — every ref has been inlined, so the section is
  // dead weight and another source of $ref noise for strict validators.
  if (resolved && typeof resolved === "object" && "components" in resolved) {
    delete resolved["components"];
  }
  return resolved;
}

/**
 * Fetch the resolved OpenAPI schema for one fal endpoint. Used by
 * `fal_run` to auto-attach the input contract to its error responses
 * when the agent calls with an empty / invalid `input` — otherwise the
 * model often forgets to follow up with `fal_search_models` and just
 * retries the same broken call. Returns null on any failure (network,
 * 404, etc.) — the caller falls back to a plain error.
 */
async function fetchFalEndpointSchema(
  endpointId: string,
  falKey: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  try {
    const params = new URLSearchParams({
      endpoint_id: endpointId,
      expand: "openapi-3.0",
      status: "active",
      limit: "1",
    });
    const res = await fetch(`https://api.fal.ai/v1/models?${params}`, {
      headers: { Authorization: `Key ${falKey}` },
      signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      models?: Array<{ openapi?: unknown }>;
    };
    const openapi = json.models?.[0]?.openapi;
    return openapi ? resolveOpenApiRefs(openapi) : null;
  } catch {
    return null;
  }
}

async function saveGenerated(
  workspace: string,
  bytes: Uint8Array,
  mediaType?: string,
): Promise<{ path: string; mediaType: string }> {
  const ext = fileExtFromMediaType(mediaType);
  const filename = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`;
  const path = resolve(workspace, "generated", filename);
  await Bun.write(path, bytes);
  return { path, mediaType: mediaType ?? "image/png" };
}

/**
 * Image generation + storage uploads via OpenAI and fal.ai. Each tool only
 * registers when its underlying key is configured, so the agent never sees
 * a tool it can't use.
 *
 * Output bytes always end up in `<workspace>/generated/<id>.<ext>` so the
 * agent can attach them with `[embed:<path>]`.
 */
export function buildImageTools(opts: {
  openaiKey: string | undefined;
  falKey: string | undefined;
  workspace: string;
}): ToolSet {
  const tools: ToolSet = {};
  const openai = opts.openaiKey
    ? createOpenAI({ apiKey: opts.openaiKey })
    : null;
  const fal = opts.falKey
    ? createFalClient({ credentials: opts.falKey })
    : null;

  if (fal) {
    const falKey = opts.falKey!;
    tools.fal_search_models = tool({
      description:
        "Search fal.ai's model registry. Returns id, display name, description, category, tags. Use to discover endpoints — don't guess. Set `with_schema: true` for ONE specific endpoint_id you're about to call to get its OpenAPI input schema (so you know which fields it expects).",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Free-text search across name / description / tags. Examples: 'face swap', 'flux pro', 'realistic portrait', 'video lipsync'.",
          ),
        category: z
          .string()
          .optional()
          .describe(
            "Filter by category. Common: `text-to-image`, `image-to-image`, `text-to-video`, `image-to-video`, `text-to-audio`, `lipsync`, `face-swap`, `inpainting`, `upscale`.",
          ),
        endpoint_id: z
          .string()
          .optional()
          .describe(
            "Look up a specific endpoint by id (e.g. `fal-ai/flux-pro/kontext`). Combine with `with_schema: true` to get its full input shape.",
          ),
        with_schema: z
          .boolean()
          .optional()
          .describe(
            "If true, include the OpenAPI 3.0 input schema for each result so you can construct a valid `input` for `fal_run`. Big payload — use only when you've narrowed down to one endpoint_id.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max number of results. Default 8."),
      }),
      execute: async (
        { query, category, endpoint_id, with_schema, limit },
        options,
      ) => {
        try {
          const params = new URLSearchParams();
          if (query) params.set("q", query);
          if (category) params.set("category", category);
          if (endpoint_id) params.set("endpoint_id", endpoint_id);
          if (with_schema) params.set("expand", "openapi-3.0");
          params.set("status", "active");
          params.set("limit", String(limit ?? 8));
          const res = await fetch(`https://api.fal.ai/v1/models?${params}`, {
            headers: { Authorization: `Key ${falKey}` },
            signal: options?.abortSignal,
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.error(
              `[fal_search_models] HTTP ${res.status} ${res.statusText} | params=${params.toString()} | body=${body.slice(0, 1500)}`,
            );
            return {
              ok: false,
              error: `HTTP ${res.status} ${res.statusText} from fal model API${body ? ` | body=${body}` : ""}`,
            };
          }
          const json = (await res.json()) as {
            models?: Array<{
              endpoint_id?: string;
              metadata?: {
                display_name?: string;
                description?: string;
                category?: string;
                tags?: string[];
                model_url?: string;
              };
              openapi?: unknown;
            }>;
          };
          const models = (json.models ?? []).map((m) => ({
            id: m.endpoint_id,
            name: m.metadata?.display_name,
            description: m.metadata?.description,
            category: m.metadata?.category,
            tags: m.metadata?.tags,
            url: m.metadata?.model_url,
            ...(with_schema && m.openapi
              ? { openapi: resolveOpenApiRefs(m.openapi) }
              : {}),
          }));
          return { ok: true, count: models.length, models };
        } catch (err) {
          console.error(`[fal_search_models] ${describeApiError(err)}`);
          return { ok: false, error: describeApiError(err) };
        }
      },
    });

    tools.fal_run = tool({
      description:
        "Run any fal.ai endpoint with a model-specific input dict. Use this for fal generation / editing / lipsync / video / audio / etc. — anything that's NOT plain OpenAI image gen.\n\nMANDATORY workflow: (1) `fal_search_models({ endpoint_id, with_schema: true })` to get the OpenAPI input schema; (2) build `input` matching that schema's required fields exactly; (3) call `fal_run`. NEVER call this with `input: {}` or guessed fields — every endpoint has different required keys (some need `prompt`, some `image_url`, some `image_urls`, some `video_url`+`audio_url`, etc.) and skipping the schema step always 422s. If you do hit 422, the schema is auto-attached to the error — read it before retrying.\n\nResult image URLs are auto-downloaded to your workspace so you can `[embed:<path>]` them directly.",
      inputSchema: z.object({
        endpoint_id: z
          .string()
          .min(1)
          .describe(
            "Fal endpoint id, e.g. `fal-ai/flux-pro/kontext`, `fal-ai/recraft-v3`, `fal-ai/sync-lipsync`.",
          ),
        // Open-ended object schemas (`additionalProperties: {}`) confuse
        // strict tool-callers — notably xAI Grok, which silently emits
        // `{}` because the schema has no concrete properties to fill.
        // Stringified JSON sidesteps the issue: every provider can fill
        // a string field, and we JSON.parse it on our side.
        input_json: z
          .string()
          .min(2)
          .describe(
            'JSON-encoded input dict for the endpoint. Examples (literal strings to put here):\n' +
              '  flux:    \'{"prompt":"a red panda","image_size":"landscape_16_9"}\'\n' +
              '  kontext: \'{"prompt":"make it sunset","image_url":"https://..."}\'\n' +
              '  lipsync: \'{"video_url":"https://...","audio_url":"https://..."}\'\n' +
              'Get the exact field list via `fal_search_models({ endpoint_id, with_schema: true })` first — every endpoint has different required keys.',
          ),
      }),
      execute: async ({ endpoint_id, input_json }, options) => {
        let input: Record<string, unknown>;
        try {
          const parsed = JSON.parse(input_json);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {
              ok: false,
              error: `input_json must decode to a JSON object, got ${
                Array.isArray(parsed) ? "array" : typeof parsed
              }.`,
            };
          }
          input = parsed as Record<string, unknown>;
        } catch (err) {
          return {
            ok: false,
            error: `Invalid JSON in input_json: ${
              err instanceof Error ? err.message : String(err)
            }. Pass a valid JSON object string, e.g. '{"prompt":"a cat"}'.`,
          };
        }

        // Pre-flight: every fal endpoint requires at least one field
        // (prompt / image_url / video_url / ...). An empty `input` is
        // always a 422, so refuse it and auto-attach the schema so the
        // next call has the right shape.
        if (Object.keys(input).length === 0) {
          const schema = await fetchFalEndpointSchema(
            endpoint_id,
            falKey,
            options?.abortSignal,
          );
          return {
            ok: false,
            error: `Empty input — fal endpoints always need fields (prompt / image_url / etc). Read the schema below and retry with the required fields.`,
            schema,
          };
        }

        try {
          const result = (await fal.subscribe(endpoint_id, {
            input,
            abortSignal: options?.abortSignal,
          })) as { data: unknown };
          // Walk result for any { url, content_type? } image-ish entries and
          // save them to disk so the agent can embed without an extra hop.
          const saved: { path: string; mediaType: string; sourceUrl: string }[] = [];
          const visited = new Set<unknown>();
          const visit = async (v: unknown): Promise<void> => {
            if (!v || typeof v !== "object" || visited.has(v)) return;
            visited.add(v);
            if (Array.isArray(v)) {
              for (const x of v) await visit(x);
              return;
            }
            const o = v as Record<string, unknown>;
            const url = typeof o.url === "string" ? o.url : undefined;
            const ct =
              typeof o.content_type === "string" ? o.content_type : undefined;
            if (
              url &&
              /^https?:\/\//i.test(url) &&
              (ct?.startsWith("image/") ||
                /\.(png|jpe?g|gif|webp|heic)(\?|$)/i.test(url))
            ) {
              try {
                const { bytes, mediaType } = await loadBytesFromSource(url);
                saved.push({
                  ...(await saveGenerated(opts.workspace, bytes, ct ?? mediaType)),
                  sourceUrl: url,
                });
              } catch (err) {
                console.warn(`[fal_run] download failed: ${url}`, err);
              }
            }
            for (const x of Object.values(o)) await visit(x);
          };
          await visit(result.data);
          return {
            ok: true,
            endpoint_id,
            data: result.data,
            saved_images:
              saved.length > 0
                ? {
                    count: saved.length,
                    images: saved,
                    hint: "Embed each with `[embed:<path>]` to send to the user.",
                  }
                : undefined,
          };
        } catch (err) {
          const errStr = describeApiError(err);
          console.error(`[fal_run] endpoint=${endpoint_id} | ${errStr}`);
          // Validation errors (422 / "Unprocessable") almost always mean
          // wrong input shape — auto-attach the schema so the agent can
          // self-correct on the next call instead of looping on the same
          // broken payload.
          if (/\b422\b|Unprocessable|Validation/i.test(errStr)) {
            const schema = await fetchFalEndpointSchema(
              endpoint_id,
              falKey,
              options?.abortSignal,
            );
            if (schema) {
              return {
                ok: false,
                error: errStr,
                schema,
                hint: "Validation failure. The schema above is the contract for this endpoint — match its required fields exactly and retry.",
              };
            }
          }
          return { ok: false, error: errStr };
        }
      },
    });

    tools.fal_upload = tool({
      description:
        "Upload a local file to fal.ai's storage and get a hosted URL back. Use when an MCP / fal model needs an `image_url` (or any URL) and you only have a local path. Native SDK upload — no shell, no truncation.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "Local filesystem path. Relative paths resolve against your workspace.",
          ),
        expires_in: z
          .enum(["never", "1h", "1d", "7d", "30d", "1y"])
          .optional()
          .describe(
            "How long the uploaded file should live on fal storage. Defaults to fal's default. Use `1h`/`1d` for ephemeral edits, `never` for long-lived references.",
          ),
      }),
      execute: async ({ path, expires_in }) => {
        try {
          const resolved = path.startsWith("/")
            ? path
            : resolve(opts.workspace, path);
          const file = Bun.file(resolved);
          if (!(await file.exists())) {
            return { ok: false, error: `File not found: ${path}` };
          }
          const blob = new Blob([await file.arrayBuffer()], {
            type: file.type || "application/octet-stream",
          });
          const url = await fal.storage.upload(
            blob,
            expires_in ? { lifecycle: { expiresIn: expires_in } } : undefined,
          );
          return { ok: true, url, mediaType: file.type || undefined };
        } catch (err) {
          console.error(
            `[fal_upload] path=${path} | ${describeApiError(err)}`,
          );
          return { ok: false, error: describeApiError(err) };
        }
      },
    });
  }

  if (openai) {
    tools.generate_image = tool({
      description:
        "Generate an image from a text prompt via OpenAI. Saves the result(s) to your workspace; embed with `[embed:<path>]` to send to the user. For fal.ai (any non-OpenAI model — flux, ideogram, recraft, lipsync, video, ...) use `fal_search_models` to discover the right endpoint then `fal_run` to call it.",
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe(
            "Detailed image description. Be specific about subject, style, composition, lighting.",
          ),
        model: z
          .enum([
            "gpt-image-2",
            "gpt-image-1.5",
            "gpt-image-1",
            "dall-e-3",
            "dall-e-2",
          ])
          .optional()
          .describe(
            "OpenAI image model. Defaults to gpt-image-2. Fall back to dall-e-3 if you hit a 'verification required' error.",
          ),
        size: z
          .string()
          .optional()
          .describe(
            "`WIDTHxHEIGHT`. gpt-image-* family: 1024x1024 (default) / 1536x1024 / 1024x1536. dall-e-3: 1024x1024 / 1792x1024 / 1024x1792. dall-e-2: 256x256 / 512x512 / 1024x1024.",
          ),
        n: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("How many images to generate (1-4). Defaults to 1."),
        reference_images: z
          .array(z.string().min(1))
          .max(4)
          .optional()
          .describe(
            "Reference images for image-to-image (gpt-image-* family only). Each item is a local path or http(s) URL.",
          ),
      }),
      execute: async (
        { prompt, model = "gpt-image-2", size, n, reference_images },
        options,
      ) => {
        try {
          const refBytes =
            reference_images && reference_images.length > 0
              ? await Promise.all(
                  reference_images.map(
                    async (s) => (await loadBytesFromSource(s)).bytes,
                  ),
                )
              : undefined;
          const finalPrompt = refBytes
            ? { text: prompt, images: refBytes }
            : prompt;
          const { images, warnings } = await generateImage({
            model: openai.image(model),
            prompt: finalPrompt,
            size: size as `${number}x${number}` | undefined,
            n,
            abortSignal: options?.abortSignal,
          });
          const saved: { path: string; mediaType: string }[] = [];
          for (const image of images) {
            saved.push(
              await saveGenerated(
                opts.workspace,
                image.uint8Array,
                image.mediaType,
              ),
            );
          }
          return {
            ok: true,
            count: saved.length,
            images: saved,
            model,
            mode: refBytes ? "edit" : "generate",
            warnings: warnings && warnings.length > 0 ? warnings : undefined,
            hint: "Embed each image in your reply with `[embed:<path>]` so it shows up in the chat.",
          };
        } catch (err) {
          return { ok: false, error: describeApiError(err) };
        }
      },
    });
  }

  return tools;
}
