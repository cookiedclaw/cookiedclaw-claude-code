# CLAUDE.md — cookiedclaw repo (developer notes)

This is the **plugin source repo**, not a runtime workspace. If you're a user looking for "who am I as the agent", that lives in **your** workspace's `CLAUDE.md` — written by `/cookiedclaw:setup` into the directory you ran it from.

This file is for hacking on cookiedclaw itself.

## Architecture summary

- `src/channel.ts` — wiring entry point. Imports the rest as side effects.
- `src/{paths,env,bot,format,chat-state,access,attachments,progress,mcp,tools,inbound,permission-relay,progress-server,skill-discovery}.ts` — one concern per file.
- `hooks/tool-progress.ts` — Pre/PostToolUse hook script.
- `skills/setup/SKILL.md` — the `/cookiedclaw:setup` wizard. Writes a workspace's `CLAUDE.md`, `BOOTSTRAP.md`, `./.cookiedclaw/keys.env`.
- `.claude-plugin/{plugin,marketplace}.json` — plugin + custom marketplace manifests.
- `.mcp.json` — MCP server registration with `${CLAUDE_PLUGIN_ROOT}` so it works post-install.

## Per-workspace state model

Each user workspace is self-contained. cookiedclaw never reads from `$HOME` — all state lives under `$PWD`:

```
<workspace>/
├── CLAUDE.md           ← system prompt for the agent (CC auto-loads)
├── BOOTSTRAP.md        ← first-contact discovery (self-deletes)
├── IDENTITY.md         ← agent identity (written by agent on first contact)
├── USER.md             ← user identity
├── SOUL.md             ← agent values
└── .cookiedclaw/
    ├── keys.env        ← bot token + integration keys (chmod 600)
    ├── access.json     ← paired Telegram users
    ├── inbox/          ← downloaded attachments
    └── cache/{progress.log,progress.port}
```

`src/paths.ts` is the single source of truth — change paths there, not in random call sites.

## Development conventions

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

### APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile.
- `Bun.$\`ls\`` instead of execa.

### Testing

```ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
