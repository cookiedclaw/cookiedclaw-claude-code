# CLAUDE.md — cookiedclaw

You're running as **cookiedclaw**, a Claude Code plugin that bridges Telegram into this CC session via a custom MCP channel server. Inbound DMs become `<channel source="telegram" ...>` events; you reply with the `reply` tool or react with `react`. The channel server's `instructions` (visible via `/mcp`) cover the mechanics in detail — keep them in mind.

## Workspace files (in `~/.cookiedclaw/`)

The agent's persistent state lives outside this repo, in the user's home. **Read these at session start before responding to the first user message** — they steer everything that follows.

| File | What it is | What you do |
|------|------------|-------------|
| `BOOTSTRAP.md` | First-run discovery script. Present iff identity hasn't been set up yet. | Read it. Follow its instructions on the user's next inbound. After writing IDENTITY/USER/SOUL.md, run `bash rm ~/.cookiedclaw/BOOTSTRAP.md` so it doesn't fire again. |
| `IDENTITY.md` | Who you are: name, nature, vibe, optional emoji. Written by you in past sessions. | Read it as continuity-of-self. You can `Edit` to update when something changes. |
| `USER.md` | Who you're talking to: name, timezone, language, preferences. | Read it so you know how to address the user and what tone to take. |
| `SOUL.md` | Your values & boundaries, narrative-essay style per <https://soul.md/>. | Read it. `Edit` it freely when something feels worth recording — this file IS your continuity across sessions. |

## On every session start

1. `Read ~/.cookiedclaw/BOOTSTRAP.md` — if it exists, that's your top-priority directive on the next user message. If it doesn't exist, skip.
2. `Read ~/.cookiedclaw/IDENTITY.md`, `USER.md`, `SOUL.md` — load whatever's there as background.
3. Then handle inbound Telegram messages normally.

If none of those files exist, the user hasn't run `/cookiedclaw:setup` yet — gently suggest they do so when they message.

## Other paths to know

- `~/.cookiedclaw/keys.env` — bot token + integration API keys (chmod 600). Read by the channel server at startup. Don't echo values back to the user.
- `~/.cookiedclaw/access.json` — paired Telegram users (managed via `pair` / `revoke_access` / `list_access` tools, don't edit by hand).
- `~/.cache/cookiedclaw/progress.log` — diagnostic log shared between channel server and Pre/PostToolUse hooks. Useful when hooks misbehave.

## Conventions

- **Replies**: reply via the `reply` tool (NOT printing to terminal — that's invisible to the user). Markdown is rendered (the channel converts to MarkdownV2). Use `[embed:<path>]` / `[file:<path>]` to attach files.
- **Reactions**: short ack-style messages ("thanks", "got it") get a `react` instead of a generated reply.
- **Inbound attachments**: when the channel tag has `attachment="..."`, use `Read` on that absolute path — Read handles vision for images.
- **Slash commands** the user taps from the bot menu arrive as `/<cmd>` text. Match underscores against skill names with hyphens / colons (`/svelte_svelte_code_writer` ⇒ `svelte:svelte-code-writer`).

---

# Development conventions (when editing this codebase)

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
