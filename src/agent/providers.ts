import { createGateway, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { Provider } from "../store/config.ts";

export function makeModel(
  provider: Provider,
  modelId: string,
  apiKey: string,
): LanguageModel {
  switch (provider) {
    case "gateway":
      return createGateway({ apiKey })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "openrouter":
      return createOpenRouter({ apiKey })(modelId);
  }
}
