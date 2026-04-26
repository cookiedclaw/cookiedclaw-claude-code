import { botPaths } from "./paths.ts";

const TEMPLATE = (path: string) => `# Onboarding (one-shot)

This is your first conversation with the user. Use it to learn the basics about who they are so you can serve them well going forward — what to call them, what language they prefer, what tone they want from you, and anything they volunteer about themselves or what they want from this bot. Save what you learn into long-term memory.

Guidelines:
- Talk naturally. Don't dump a list of questions — weave two or three short ones into a friendly first-chat exchange, in the user's language.
- You may already have memories seeded by the manager that spawned you. Reflect that in how you greet — don't ask things you already know.
- When you have enough to start (at minimum: their name and language preference, plus any tone/style cues they've shared), delete this file with \`bash rm ${path}\`. Once removed, the onboarding instructions stop appearing in your system prompt and you can chat normally.
- If the user explicitly says "skip the questions" / "you already know me" / "let's just chat" / "забей, давай просто общаться", delete the file immediately and acknowledge.
`;

export async function writeBootstrapFile(botId: number): Promise<void> {
  const path = botPaths(botId).bootstrapFile;
  await Bun.write(path, TEMPLATE(path));
}

export async function readBootstrapFile(botId: number): Promise<string | null> {
  const file = Bun.file(botPaths(botId).bootstrapFile);
  if (!(await file.exists())) return null;
  return await file.text();
}
