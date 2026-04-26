/**
 * Filesystem paths cookiedclaw uses, plus the shared diagnostic log.
 *
 * Two roots:
 *   - `~/.cookiedclaw/` for user-owned state (keys.env, BOOTSTRAP/IDENTITY/
 *     USER/SOUL.md, access.json)
 *   - `~/.cache/cookiedclaw/` for runtime artifacts (progress.port,
 *     progress.log, inbox/<downloaded-attachments>)
 *
 * Both are created lazily so the channel doesn't crash on a fresh box.
 */
import { appendFile, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const HOME = process.env.HOME ?? "/tmp";

/** The cookiedclaw plugin's project root (parent of `src/`). */
export const projectRoot = resolve(import.meta.dir, "..");

/** User-owned state — survives plugin upgrades, edited by the agent. */
export const dotCookiedclaw = resolve(HOME, ".cookiedclaw");

/** Runtime cache — port file, debug log, downloaded attachments. */
export const cacheDir = resolve(HOME, ".cache", "cookiedclaw");

/** Where we stash inbound Telegram photos / documents for CC to Read. */
export const inboxDir = resolve(cacheDir, "inbox");

/** Channel server writes its progress-server port here at startup; hooks read it. */
export const portFile = resolve(cacheDir, "progress.port");

/**
 * Append-only diagnostic log shared between the channel server and the
 * Pre/PostToolUse hook script. Lets us debug "why didn't the typing
 * indicator update" without flipping CC's debug-log toggle.
 */
export const debugLog = resolve(cacheDir, "progress.log");

mkdirSync(cacheDir, { recursive: true });
mkdirSync(inboxDir, { recursive: true });

/** Append a tagged line to {@link debugLog}. Best-effort, never throws. */
export function dlog(line: string): void {
  appendFile(
    debugLog,
    `[${new Date().toISOString()}] [server] ${line}\n`,
    () => {},
  );
}
