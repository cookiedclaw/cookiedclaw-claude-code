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
import { dlog, workspaceRoot } from "./paths.ts";

type DiscoveredCommand = { command: string; description: string };

/** Cap descriptions to keep the /skills chat reply scannable; most CC
 * skill descriptions blow well past this otherwise. */
const TELEGRAM_DESC_LIMIT = 120;

/** Skills/commands matching these are CC-internal noise, not things a
 * user would tap from a phone. Hides the worst clutter. */
const HIDDEN_PATTERNS = [
  /^deprecated/i,
  // CC's plumbing-style skills: code-review, debugging, planning loops,
  // etc. Useful inside CC, useless from Telegram chat where the work
  // happens through normal conversation anyway.
  /^superpowers_/,
];

/** Built-in cookiedclaw commands. These are the ONLY commands published
 * to the Telegram bot menu — discovered skills aren't registered there
 * because the menu blew past Telegram's undocumented payload cap once
 * users had a few plugins. Instead, `/skills` shows the full list as a
 * chat reply, and the user types skill commands as text. */
const BUILTIN_COMMANDS: DiscoveredCommand[] = [
  {
    command: "stop",
    description: "Abort whatever the bot is doing right now",
  },
  {
    command: "skills",
    description: "List available skills you can invoke as text",
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
  // Workspace-local .claude/ — anything the user dropped into this agent's
  // workspace. Useful for per-agent custom commands.
  await readSkillsAt(resolve(workspaceRoot, ".claude"), undefined, out);

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
    .sort((a, b) => a.command.localeCompare(b.command));
}

/**
 * Publish the Telegram bot menu. We only ship built-ins (`/stop`,
 * `/skills`) — discovered skills are kept out of the menu and surfaced
 * via the `/skills` command instead. Telegram's undocumented payload
 * cap was a constant friction otherwise once users had a few plugins.
 */
export async function publishBotMenu(): Promise<void> {
  try {
    await bot.api.setMyCommands(BUILTIN_COMMANDS);
    console.error(
      `[telegram] published bot menu: ${BUILTIN_COMMANDS.map((c) => `/${c.command}`).join(" ")}`,
    );
    dlog(`bot menu set with ${BUILTIN_COMMANDS.length} built-in commands`);
  } catch (err) {
    console.error(
      `[telegram] failed to publish bot commands menu: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Render the discovered-skills list as a Telegram MarkdownV2 reply.
 * Telegram auto-detects `/command` text and makes it tappable, so the
 * user can launch any skill from the list with one tap. Falls back to a
 * friendly empty-state if discovery turned up nothing.
 */
export async function formatSkillsListMessage(): Promise<string> {
  let discovered: DiscoveredCommand[];
  try {
    discovered = await discoverCommands();
  } catch (err) {
    console.error(
      `[telegram] discovery failed: ${err instanceof Error ? err.message : err}`,
    );
    discovered = [];
  }
  if (discovered.length === 0) {
    return "No skills discovered. Try installing a Claude Code plugin or dropping a skill under `~/.claude/skills/`.";
  }
  // Telegram's hard limit is 4096 chars; MarkdownV2 escaping inflates
  // that. Reserve headroom and tail-truncate with a "+N more" hint.
  const TELEGRAM_MSG_BUDGET = 3500;
  const header = "🛠 Available skills (tap to invoke):";
  const lines = [header, ""];
  let used = header.length + 1;
  let shown = 0;
  for (const c of discovered) {
    const line = `/${c.command} — ${c.description}`;
    if (used + line.length + 1 > TELEGRAM_MSG_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < discovered.length) {
    lines.push("", `(+${discovered.length - shown} more — message budget hit)`);
  }
  return lines.join("\n");
}
