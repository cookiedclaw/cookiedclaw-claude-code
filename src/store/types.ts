import type { ModelMessage } from "ai";
import type { Provider } from "./config.ts";

export type SessionKey = {
  chatId: number;
};

export type Session = {
  chatId: number;
  createdAt: number;
  lastActive: number;
  systemPromptOverride?: string;
  provider?: Provider;
  model?: string;
};

export type Sender = {
  id: number;
  name: string;
  username?: string;
};

/**
 * What we persist per JSONL line. We keep the AI SDK `ModelMessage` verbatim
 * so multi-step tool calls + tool results survive across turns. Image bytes
 * inside user messages are NOT JSON-friendly, so we strip them and keep
 * disk paths in a side-table; bytes get reattached at read time.
 */
export type StoredMessage = {
  ts: number;
  /** Sender info for user messages — used to render the [Name] prefix on rebuild. */
  from?: Sender;
  /** Side-table of disk paths for user-message images. */
  imagePaths?: Array<{ path: string; mediaType?: string }>;
  message: ModelMessage;
  /**
   * When true, this entry is a synthetic summary of all earlier entries on
   * disk. `readHistory` returns only the last compaction entry (and what
   * follows), so older messages are kept on disk but not replayed to the
   * model. The `message` should be a synthetic assistant message containing
   * the summary text.
   */
  compaction?: true;
};

export function formatSender(from: Sender): string {
  return from.username ? `[${from.name} @${from.username}]` : `[${from.name}]`;
}

export const sessionId = (key: SessionKey): string => String(key.chatId);
