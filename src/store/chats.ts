import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { BotPaths } from "../runtime/paths.ts";
import type { Sender, SessionKey, StoredMessage } from "./types.ts";

/** Legacy on-disk shape from before we persisted ModelMessages directly. */
type LegacyEntry = {
  role: "user" | "assistant" | "tool";
  content: string;
  from?: Sender;
  attachments?: Array<{ kind: "image"; path: string; mediaType?: string }>;
  ts: number;
};

function isLegacy(raw: unknown): raw is LegacyEntry {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "role" in raw &&
    !("message" in raw)
  );
}

function migrate(raw: LegacyEntry): StoredMessage {
  const message: ModelMessage =
    raw.role === "tool"
      ? { role: "assistant", content: raw.content }
      : { role: raw.role, content: raw.content };
  const imagePaths = raw.attachments
    ?.filter((a) => a.kind === "image")
    .map((a) => ({ path: a.path, mediaType: a.mediaType }));
  return {
    ts: raw.ts,
    from: raw.from,
    imagePaths,
    message,
  };
}

function normalize(raw: unknown): StoredMessage | null {
  if (isLegacy(raw)) return migrate(raw);
  if (
    typeof raw === "object" &&
    raw !== null &&
    "message" in raw &&
    "ts" in raw
  ) {
    return raw as StoredMessage;
  }
  return null;
}

export function createChatStore(paths: BotPaths) {
  function chatFile(key: SessionKey): string {
    return join(paths.chats, `${key.chatId}.jsonl`);
  }

  async function readLines(path: string): Promise<string[]> {
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    return text.split("\n").filter(Boolean);
  }

  return {
    async appendMessage(key: SessionKey, msg: StoredMessage): Promise<void> {
      const path = chatFile(key);
      const lines = await readLines(path);
      lines.push(JSON.stringify(msg));
      await Bun.write(path, lines.join("\n") + "\n");
    },

    async appendModelMessages(
      key: SessionKey,
      messages: ModelMessage[],
    ): Promise<void> {
      const path = chatFile(key);
      const lines = await readLines(path);
      const ts = Date.now();
      for (const message of messages) {
        lines.push(JSON.stringify({ ts, message } satisfies StoredMessage));
      }
      await Bun.write(path, lines.join("\n") + "\n");
    },

    /**
     * Append a compaction marker. The summary becomes a synthetic assistant
     * message that replaces all prior entries on subsequent reads. Older
     * messages stay on disk for debugging but are skipped on read.
     */
    async appendCompaction(
      key: SessionKey,
      summary: string,
    ): Promise<void> {
      const path = chatFile(key);
      const lines = await readLines(path);
      const entry: StoredMessage = {
        ts: Date.now(),
        compaction: true,
        message: {
          role: "assistant",
          content: `[Summary of earlier conversation] ${summary}`,
        },
      };
      lines.push(JSON.stringify(entry));
      await Bun.write(path, lines.join("\n") + "\n");
    },

    async readHistory(
      key: SessionKey,
      limit?: number,
    ): Promise<StoredMessage[]> {
      const lines = await readLines(chatFile(key));
      const messages: StoredMessage[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const m = normalize(parsed);
          if (m) messages.push(m);
        } catch {
          // skip corrupt lines
        }
      }
      // Compaction supersedes everything before it: keep only the last
      // compaction entry and the messages that follow.
      let lastCompactionIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.compaction) {
          lastCompactionIdx = i;
          break;
        }
      }
      const slice =
        lastCompactionIdx >= 0
          ? messages.slice(lastCompactionIdx)
          : messages;
      return limit ? slice.slice(-limit) : slice;
    },

    async clearHistory(key: SessionKey): Promise<void> {
      const file = Bun.file(chatFile(key));
      if (await file.exists()) await file.delete();
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;
