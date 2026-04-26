import { tool } from "ai";
import { z } from "zod";
import type { Skill } from "../skills/loader.ts";

/**
 * Per the AI SDK "agent skills" pattern: a single `loadSkill` tool that
 * returns the skill's full SKILL.md body plus its directory path. The agent
 * then reads bundled references and runs scripts using the regular `read`
 * and `bash` tools — paths inside the returned `skillDirectory`.
 *
 * Progressive disclosure: the system prompt only carries skill names +
 * descriptions; the full body is loaded on demand.
 */
export function buildSkillTools(skills: Skill[]) {
  const skillsByName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));

  return {
    loadSkill: tool({
      description:
        "Load a skill's full instructions plus its directory path. Use this when an item from the available skills list might help with the user's request. The returned `skillDirectory` is an absolute path you can pass to `read` (for references) and `bash` (for scripts).",
      inputSchema: z.object({
        name: z.string().describe("The skill name from the available list."),
      }),
      execute: async ({ name }) => {
        const skill = skillsByName.get(name.toLowerCase());
        if (!skill) return { ok: false, error: `Skill '${name}' not found` };
        return {
          ok: true,
          skillDirectory: skill.dir,
          content: skill.body,
        };
      },
    }),
  };
}
