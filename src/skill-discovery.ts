/**
 * Discover Claude Code skills + commands from user/project/plugin
 * directories and publish them as the Telegram bot's slash menu.
 *
 *   `/cookiedclaw_setup`, `/svelte_svelte_code_writer`, etc. are dynamic;
 *   `/stop` is a built-in cookiedclaw command that always wins the slot.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import matter from "gray-matter";
import { bot } from "./bot.ts";
import { dlog, projectRoot } from "./paths.ts";

type DiscoveredCommand = { command: string; description: string };

/** Telegram's documented 100-command cap is aspirational; in practice
 * BOT_COMMANDS_TOO_MUCH fires well below that — there's an undocumented
 * ~4 KB total-payload ceiling. We start optimistic and back off if
 * Telegram complains. */
const TELEGRAM_MAX_BOT_COMMANDS = 30;

/** Cap descriptions short enough that 30 commands fit under the implicit
 * payload cap. Still informative for the menu UI. */
const TELEGRAM_DESC_LIMIT = 100;

/** Skills/commands matching these are CC-internal noise, not things a
 * user would tap from a phone. Hides the worst clutter. */
const HIDDEN_PATTERNS = [
  /^deprecated/i,
  // CC's plumbing-style skills: code-review, debugging, planning loops,
  // etc. Useful inside CC, useless from Telegram chat where the work
  // happens through normal conversation anyway.
  /^superpowers_/,
];

/** Built-in cookiedclaw commands that always appear first in the menu,
 * regardless of what skills discovery turns up. Built-ins win
 * collisions — `/stop` shouldn't be reassignable. */
const BUILTIN_COMMANDS: DiscoveredCommand[] = [
  {
    command: "stop",
    description: "Abort whatever the bot is doing right now",
  },
];

/**
 * Extract `description` from a SKILL.md / command.md YAML frontmatter
 * block. gray-matter handles awkward cases (multi-line strings, quoted/
 * unquoted, special chars) that a hand-rolled regex wouldn't.
 */
function parseFrontmatterDescription(raw: string): string | undefined {
  let parsed: { data: Record<string, unknown> };
  try {
    parsed = matter(raw);
  } catch {
    return undefined;
  }
  const desc = parsed.data?.description;
  return typeof desc === "string" && desc.trim() ? desc.trim() : undefined;
}

/**
 * Telegram bot commands must match `[a-z0-9_]{1,32}`. Skills can have
 * hyphens; plugin namespaces use `:`. Squash both to underscores and
 * drop anything else; truncate to 32 chars.
 */
function normalizeCommandName(raw: string): string | undefined {
  // Slice FIRST, then trim trailing underscores — otherwise truncation
  // in the middle of a word leaves names like
  // `/superpowers_verification_`.
  const norm = raw
    .toLowerCase()
    .replace(/[-:]/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 32)
    .replace(/^_+|_+$/g, "");
  return norm || undefined;
}

/**
 * Scan `<root>/skills/*\/SKILL.md` and `<root>/commands/*.md`, parse each
 * for a description, and add to `out` keyed by Telegram-normalized name.
 * `namespace` (plugin name) prefixes the command if set.
 */
async function readSkillsAt(
  root: string,
  namespace: string | undefined,
  out: Map<string, DiscoveredCommand>,
): Promise<void> {
  for (const [subdir, glob, getName] of [
    [
      "skills",
      "*/SKILL.md",
      (rel: string) => rel.split("/")[0],
    ] as const,
    [
      "commands",
      "*.md",
      (rel: string) => rel.replace(/\.md$/i, ""),
    ] as const,
  ]) {
    const dir = resolve(root, subdir);
    if (!existsSync(dir)) continue;
    const g = new Bun.Glob(glob);
    for await (const rel of g.scan({ cwd: dir })) {
      const name = getName(rel);
      if (!name) continue;
      let raw: string;
      try {
        raw = await Bun.file(resolve(dir, rel)).text();
      } catch {
        continue;
      }
      const description = parseFrontmatterDescription(raw);
      if (!description) continue;
      const cmd = normalizeCommandName(
        namespace ? `${namespace}_${name}` : name,
      );
      if (!cmd) continue;
      out.set(cmd, {
        command: cmd,
        description: description.slice(0, TELEGRAM_DESC_LIMIT),
      });
    }
  }
}

type InstalledPlugin = {
  id: string;
  installPath: string;
  enabled: boolean;
};

/**
 * Authoritative list of installed + enabled plugins from CC itself.
 * Beats globbing `~/.claude/plugins/cache/*\/*\/*\/` because:
 *  - CC tells us which version is active (cache may hold many)
 *  - Disabled plugins are filtered out
 *  - We get the canonical install path
 *
 * Falls back to an empty list on any failure (CC missing from PATH,
 * stale cache, etc.) — discovery degrades to user/project skills only.
 */
async function listEnabledPlugins(): Promise<InstalledPlugin[]> {
  try {
    const proc = Bun.spawn(["claude", "plugin", "list", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0 || !out.trim()) return [];
    const parsed = JSON.parse(out) as Array<Partial<InstalledPlugin>>;
    return parsed.filter(
      (p): p is InstalledPlugin =>
        typeof p.id === "string" &&
        typeof p.installPath === "string" &&
        p.enabled === true,
    );
  } catch (err) {
    dlog(
      `claude plugin list failed: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

async function discoverCommands(): Promise<DiscoveredCommand[]> {
  const home = process.env.HOME ?? "/";
  const homeClaudeDir = resolve(home, ".claude");
  const out = new Map<string, DiscoveredCommand>();

  // User-level skills/commands (no namespace).
  await readSkillsAt(homeClaudeDir, undefined, out);
  // This project's .claude/ — skills/commands shipped with the repo.
  await readSkillsAt(resolve(projectRoot, ".claude"), undefined, out);

  // Plugins: ask CC directly — it knows which version is active and
  // which are enabled. Plugin id is "<name>@<marketplace>"; namespace
  // = name.
  const plugins = await listEnabledPlugins();
  for (const p of plugins) {
    const namespace = p.id.split("@")[0] ?? p.id;
    try {
      await readSkillsAt(p.installPath, namespace, out);
    } catch (err) {
      dlog(
        `skill scan failed for plugin ${namespace}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return [...out.values()]
    .filter(
      (c) =>
        !HIDDEN_PATTERNS.some((re) => re.test(c.command)) &&
        !HIDDEN_PATTERNS.some((re) => re.test(c.description)),
    )
    .sort((a, b) => a.command.localeCompare(b.command))
    .slice(0, TELEGRAM_MAX_BOT_COMMANDS);
}

/**
 * Discover skills + built-ins, then publish to Telegram with geometric
 * backoff if Telegram rejects on payload size. Built-ins prepend so
 * they survive the cap and never collide with discovered names.
 */
export async function publishBotMenu(): Promise<void> {
  let discovered: DiscoveredCommand[];
  try {
    discovered = await discoverCommands();
  } catch (err) {
    console.error(
      `[telegram] discovery failed: ${err instanceof Error ? err.message : err}`,
    );
    discovered = [];
  }
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.command));
  const cmds = [
    ...BUILTIN_COMMANDS,
    ...discovered.filter((c) => !builtinNames.has(c.command)),
  ].slice(0, TELEGRAM_MAX_BOT_COMMANDS);
  if (cmds.length === 0) {
    console.error(`[telegram] no commands to publish to bot menu`);
    return;
  }

  // Telegram's payload cap isn't documented; back off geometrically on
  // BOT_COMMANDS_TOO_MUCH so we don't have to hand-tune the cap forever.
  let attempt = cmds.slice();
  for (let i = 0; i < 5 && attempt.length > 0; i++) {
    try {
      await bot.api.setMyCommands(attempt);
      console.error(
        `[telegram] published ${attempt.length}/${cmds.length} command(s) to bot menu: ${attempt
          .slice(0, 5)
          .map((c) => `/${c.command}`)
          .join(" ")}${attempt.length > 5 ? " …" : ""}`,
      );
      dlog(`bot menu set with ${attempt.length} commands`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("BOT_COMMANDS_TOO_MUCH") || msg.includes("too long")) {
        const next = Math.max(1, Math.floor(attempt.length * 0.6));
        if (next === attempt.length) break;
        dlog(`menu publish: ${attempt.length} too many, retry with ${next}`);
        attempt = attempt.slice(0, next);
        continue;
      }
      console.error(`[telegram] failed to publish bot commands menu: ${msg}`);
      return;
    }
  }
  console.error(
    `[telegram] gave up publishing bot menu after backoff (had ${cmds.length} candidates)`,
  );
}
