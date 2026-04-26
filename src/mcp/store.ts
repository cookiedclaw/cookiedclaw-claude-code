import type { BotPaths } from "../runtime/paths.ts";

export type StdioServer = {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type HttpServer = {
  transport: "http";
  url: string;
  bearer?: string;
};

export type ServerConfig = StdioServer | HttpServer;

export type McpFile = {
  servers: Record<string, ServerConfig>;
};

export function createMcpStore(paths: BotPaths) {
  async function read(): Promise<McpFile> {
    const file = Bun.file(paths.mcpConfig);
    if (!(await file.exists())) return { servers: {} };
    return (await file.json()) as McpFile;
  }

  async function write(file: McpFile): Promise<void> {
    await Bun.write(paths.mcpConfig, JSON.stringify(file, null, 2));
  }

  return {
    read,
    write,

    async addServer(name: string, server: ServerConfig): Promise<void> {
      const file = await read();
      file.servers[name] = server;
      await write(file);
    },

    async removeServer(name: string): Promise<boolean> {
      const file = await read();
      if (!(name in file.servers)) return false;
      delete file.servers[name];
      await write(file);
      return true;
    },

    async listServers(): Promise<Array<{ name: string; server: ServerConfig }>> {
      const file = await read();
      return Object.entries(file.servers).map(([name, server]) => ({
        name,
        server,
      }));
    },
  };
}

export type McpStore = ReturnType<typeof createMcpStore>;
