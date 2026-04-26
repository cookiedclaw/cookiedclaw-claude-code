import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { sharedPaths } from "../runtime/paths.ts";

export type Skill = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  dir: string;
  body: string;
  source: string;
};

/**
 * Roots scanned for SKILL.md files, in priority order. First match wins on
 * name collisions.
 *
 * - `~/.cookiedclaw/skills` — our own canonical store.
 * - `~/.agents/skills` — skills.sh's standard global path; populated by
 *   `npx skills add <repo> -g -a <agent>` for many agents (cline, warp, etc.).
 * - `./.agents/skills` — skills.sh project-local convention used by 13+
 *   agents (amp, codex, cursor, gemini-cli, opencode, ...). Picked up if the
 *   bot is started from a project that has installed skills.
 */
function skillRoots(): string[] {
  const home = homedir();
  return [
    sharedPaths.skills,
    join(home, ".agents", "skills"),
    resolve(process.cwd(), ".agents", "skills"),
  ];
}

export async function loadSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  const seen = new Set<string>();
  const glob = new Bun.Glob("*/SKILL.md");

  for (const root of skillRoots()) {
    if (!existsSync(root)) continue;

    for await (const rel of glob.scan({ cwd: root })) {
      const dir = join(root, rel.replace(/\/SKILL\.md$/, ""));
      const skillFile = Bun.file(join(root, rel));
      const text = await skillFile.text();
      const { data, content } = matter(text);
      if (!data.name || !data.description) {
        console.warn(`[skills] ${root}/${rel}: SKILL.md missing name or description`);
        continue;
      }
      if (seen.has(data.name)) continue;
      seen.add(data.name);

      skills.push({
        name: data.name,
        description: data.description,
        license: data.license,
        compatibility: data.compatibility,
        dir,
        body: content,
        source: root,
      });
    }
  }

  return skills;
}
