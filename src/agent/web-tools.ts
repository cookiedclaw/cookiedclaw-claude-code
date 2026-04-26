import { tool, type ToolSet } from "ai";
import { tavily } from "@tavily/core";
import { z } from "zod";
import { abortable } from "./util.ts";

export function buildWebTools(tavilyKey: string | undefined): ToolSet {
  if (!tavilyKey) return {};

  const tvly = tavily({ apiKey: tavilyKey });

  return {
    web_search: tool({
      description:
        "Search the web for current information. Use when the user asks about news, recent events, or anything you don't know from training. Returns a list of results with title, URL, and snippet.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query"),
      }),
      execute: async ({ query }, options) => {
        try {
          const res = await abortable(
            tvly.search(query, { maxResults: 5, includeAnswer: true }),
            options?.abortSignal,
          );
          return {
            ok: true,
            answer: res.answer ?? null,
            results: res.results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.content,
            })),
          };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),

    web_fetch: tool({
      description:
        "Fetch the full text content of a specific URL. Use when the user shares a link, when web_search returned a promising URL you want to read in full, or when you need the contents of a known page. Returns clean markdown of the page.",
      inputSchema: z.object({
        url: z.string().url().describe("Absolute URL to fetch."),
      }),
      execute: async ({ url }, options) => {
        try {
          const res = await abortable(
            tvly.extract([url], { extractDepth: "basic", format: "markdown" }),
            options?.abortSignal,
          );
          const result = res.results[0];
          if (!result) {
            const failed = res.failedResults[0];
            return {
              ok: false,
              error: failed?.error ?? "No content extracted",
            };
          }
          return {
            ok: true,
            url: result.url,
            title: result.title,
            content: result.rawContent,
          };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
  };
}
