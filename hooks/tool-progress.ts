#!/usr/bin/env bun
/**
 * PreToolUse / PostToolUse hook: forwards the event to the Telegram
 * channel server's localhost endpoint so the user sees a live tool log
 * in the chat.
 *
 * CC spawns this fresh per tool call, pipes the event JSON on stdin, and
 * looks at exit code 0 / non-zero (we never block — exit 0 always). The
 * channel server picked a free port at startup and wrote it to
 *   ./.cookiedclaw/cache/progress.port  (relative to CC's CWD = the
 *   user's workspace).
 *
 * Invocation: `bun .../hooks/tool-progress.ts pre|post`
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

// Hook subprocess inherits CC's CWD = the workspace root. The channel
// server uses the same relative path, so port + log files line up.
const dataDir = resolve(process.cwd(), ".cookiedclaw", "cache");
const portFile = resolve(dataDir, "progress.port");
const debugLog = resolve(dataDir, "progress.log");
const stopFlagPath = resolve(dataDir, "stop.flag");

/** Tool names CC must still be able to call after /stop — otherwise the
 * agent can't acknowledge the abort. */
function isReplyOrReact(name: string): boolean {
  return /^(reply|react)$|^mcp__.+__(reply|react)$/.test(name);
}

function dlog(line: string): void {
  try {
    appendFileSync(
      debugLog,
      `[${new Date().toISOString()}] [hook] ${line}\n`,
    );
  } catch {
    // best-effort
  }
}

const phase = process.argv[2];
if (phase !== "pre" && phase !== "post") {
  dlog(`bad phase arg: ${phase}`);
  process.exit(0); // never block CC — silent failure beats broken loop
}

let raw: string;
try {
  raw = await Bun.stdin.text();
} catch {
  process.exit(0);
}
if (!raw) process.exit(0);

let event: {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  duration_ms?: number;
};
try {
  event = JSON.parse(raw);
} catch {
  process.exit(0);
}

if (!event.tool_name || !event.tool_use_id) {
  dlog(`missing tool_name or tool_use_id: ${JSON.stringify(event).slice(0, 200)}`);
  process.exit(0);
}

// /stop abort: if the channel server has set stop.flag recently, block
// every non-reply/react tool call so the agent physically can't keep
// working. Reply/react still go through so it can acknowledge the stop.
// Flag is cleared by forwardToCC on the next user inbound, or expires
// after 5 minutes as a defense against orphaned flags.
if (phase === "pre" && !isReplyOrReact(event.tool_name)) {
  try {
    const flagText = (await Bun.file(stopFlagPath).text()).trim();
    const ts = Number(flagText);
    if (Number.isFinite(ts) && Date.now() - ts < 5 * 60 * 1000) {
      dlog(`/stop active — blocking ${event.tool_name}`);
      console.error(
        "User pressed /stop — abort the current task. Acknowledge with the `reply` or `react` tool, then end your turn. Do not run any further tools.",
      );
      process.exit(2);
    }
  } catch {
    // No flag, proceed normally
  }
}

let port: number | undefined;
try {
  const s = (await Bun.file(portFile).text()).trim();
  port = Number(s);
  if (!Number.isFinite(port)) port = undefined;
} catch (err) {
  dlog(`no port file at ${portFile}: ${err instanceof Error ? err.message : err}`);
  process.exit(0);
}
if (!port) {
  dlog(`port file existed but value invalid`);
  process.exit(0);
}

dlog(`forwarding ${phase} ${event.tool_name} (id=${event.tool_use_id}) to :${port}`);

// Detect tool errors from PostToolUse response. CC's tool_response shape
// varies, but failures usually surface as `is_error: true` or a content
// block flagged that way.
const resp = event.tool_response as
  | { is_error?: boolean; isError?: boolean; content?: unknown }
  | null
  | undefined;
const isError = Boolean(resp?.is_error || resp?.isError);
let errorText: string | undefined;
if (isError && resp?.content) {
  if (Array.isArray(resp.content)) {
    const firstText = resp.content.find(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" &&
        c !== null &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    );
    errorText = firstText?.text;
  } else if (typeof resp.content === "string") {
    errorText = resp.content;
  }
}

const payload = {
  phase,
  tool_name: event.tool_name,
  tool_use_id: event.tool_use_id,
  tool_input: event.tool_input,
  duration_ms: event.duration_ms,
  is_error: isError,
  error_text: errorText,
};

try {
  // Short timeout — we never want to slow the tool loop.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: ctl.signal,
  });
  clearTimeout(timer);
  dlog(`POST → ${res.status}`);
} catch (err) {
  dlog(`POST failed: ${err instanceof Error ? err.message : err}`);
}

process.exit(0);
