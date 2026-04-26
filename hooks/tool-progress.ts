#!/usr/bin/env bun
/**
 * PreToolUse / PostToolUse hook: forwards the event to the Telegram
 * channel server's localhost endpoint so the user sees a live tool log
 * in the chat.
 *
 * CC spawns this fresh per tool call, pipes the event JSON on stdin, and
 * looks at exit code 0 / non-zero (we never block — exit 0 always). The
 * channel server picked a free port at startup and wrote it to
 *   $CLAUDE_PLUGIN_DATA/progress.port  (or ~/.cache/cookiedclaw/progress.port
 *   under dev mode, where CLAUDE_PLUGIN_DATA isn't set).
 *
 * Invocation: `bun .../hooks/tool-progress.ts pre|post`
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

// Same path as the channel server. We deliberately don't use
// CLAUDE_PLUGIN_DATA — CC's hook env and MCP-server env aren't guaranteed
// equal, and a fixed path sidesteps that mismatch.
const dataDir = resolve(process.env.HOME ?? "/tmp", ".cache", "cookiedclaw");
const portFile = resolve(dataDir, "progress.port");
const debugLog = resolve(dataDir, "progress.log");

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
