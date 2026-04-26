import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { McpStore } from "./store.ts";

type AnyClient = { close: () => Promise<void> };

export type LoadResult = {
  servers: number;
  tools: number;
  errors: Array<{ name: string; message: string }>;
};

export function createMcpManager(store: McpStore) {
  let clients: AnyClient[] = [];
  let toolMap: Record<string, unknown> = {};

  async function close(): Promise<void> {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    clients = [];
    toolMap = {};
  }

  async function load(): Promise<LoadResult> {
    await close();
    const file = await store.read();
    const errors: LoadResult["errors"] = [];

    for (const [name, server] of Object.entries(file.servers)) {
      try {
        const client = await createMCPClient({
          transport:
            server.transport === "http"
              ? {
                  type: "http",
                  url: server.url,
                  headers: server.bearer
                    ? { Authorization: `Bearer ${server.bearer}` }
                    : undefined,
                }
              : new Experimental_StdioMCPTransport({
                  command: server.command,
                  args: server.args ?? [],
                  env: server.env,
                }),
        });
        const serverTools = await client.tools();
        for (const [toolName, tool] of Object.entries(serverTools)) {
          toolMap[`${name}__${toolName}`] = tool;
        }
        clients.push(client);
      } catch (err) {
        errors.push({
          name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      servers: clients.length,
      tools: Object.keys(toolMap).length,
      errors,
    };
  }

  return {
    load,
    close,
    getTools: () => toolMap,
  };
}

export type McpManager = ReturnType<typeof createMcpManager>;
