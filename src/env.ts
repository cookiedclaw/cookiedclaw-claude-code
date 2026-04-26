/**
 * Loads `.env`-style files into `process.env` at module-init time, then
 * surfaces the cookiedclaw-relevant values as named exports for the rest
 * of the codebase.
 *
 * Two sources, in priority order:
 *   1. `~/.cookiedclaw/keys.env` — where /cookiedclaw:setup writes
 *      everything. Survives plugin upgrades and works regardless of cwd.
 *   2. The plugin project's own `.env` — legacy / dev-mode source.
 *
 * Shell env wins over both because we only set keys that aren't already
 * in process.env.
 */
import { resolve } from "node:path";
import { dotCookiedclaw, projectRoot } from "./paths.ts";

const envPaths = [
  resolve(dotCookiedclaw, "keys.env"),
  resolve(projectRoot, ".env"),
];

for (const envPath of envPaths) {
  const file = Bun.file(envPath);
  if (!(await file.exists())) continue;
  const text = await file.text();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const [, key, rawValue] = m as unknown as [string, string, string];
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
  console.error(`[telegram] loaded env from ${envPath}`);
}

/**
 * Telegram bot token resolved from env. Accepts the official-plugin name
 * `TELEGRAM_BOT_TOKEN` first, falls back to legacy `TELEGRAM_API_TOKEN`
 * for upgrade-in-place from earlier cookiedclaw versions.
 */
export const token =
  process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_API_TOKEN;

/** `true` when a real token is present and bot polling can start. */
export const hasToken = Boolean(token);

if (!hasToken) {
  // First-run case: user installed cookiedclaw but hasn't gone through
  // setup yet. We MUST stay alive — otherwise the plugin's MCP server
  // dies and the /cookiedclaw:setup skill (the thing that fixes this)
  // becomes unreachable from CC. So: log a friendly note, skip bot
  // polling, but keep the MCP server up so its tools and the setup
  // skill stay available.
  console.error(
    `[telegram] no Telegram bot token yet — bot polling disabled.\n` +
      `  Run /cookiedclaw:setup in Claude Code to configure one,\n` +
      `  then restart claude. MCP tools (pair, list_access, …) and the\n` +
      `  setup skill stay available in the meantime.`,
  );
}

const allowedRaw = process.env.TELEGRAM_ALLOWED_USERS ?? "";

/** `*` in TELEGRAM_ALLOWED_USERS = let everyone through (only for testing). */
export const allowAll = allowedRaw.trim() === "*";

/** Static env-based allowlist; complements the persistent paired-users set. */
export const allowedUsers = new Set(
  allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (!allowAll && allowedUsers.size === 0) {
  console.error(
    "[telegram] TELEGRAM_ALLOWED_USERS is empty — bot starts in pairing-only mode. " +
      "Anyone who DMs the bot will get a code; ask Claude to `pair <code>` to approve them. " +
      "(Or set TELEGRAM_ALLOWED_USERS=<your_user_id> for an env-based bypass.)",
  );
}
