---
name: setup
description: Configure cookiedclaw integrations — fal.ai for image generation, Supermemory for long-term memory. Walks through API key setup and registers the matching MCP servers in Claude Code so they become available across all sessions (including via the Telegram bot).
disable-model-invocation: true
allowed-tools: Bash(claude mcp *) Bash(mkdir *) Bash(chmod *) Bash(test *) Read Write Edit WebSearch WebFetch
---

# cookiedclaw onboarding wizard

You are walking the user through configuring the optional integrations cookiedclaw can use. The Telegram channel itself is already running (otherwise this skill wouldn't load); this wizard is about the *capabilities* on top.

Be conversational. Ask one thing at a time. Never paste API keys back to the user — they typed them, treat them as secrets. Don't echo them in confirmations.

## Step 1 — Survey current state (no questions yet)

Before asking anything, gather what's already configured so you don't ask for things they have:

1. Read `~/.cookiedclaw/keys.env` if it exists. Note which of `FAL_KEY`, `SUPERMEMORY_API_KEY` are present.
2. Run `claude mcp list` and note any servers that look related (anything with `fal`, `supermemory` in the name).
3. Briefly tell the user the current state in one or two sentences. Example: *"Looks like fal.ai is already set up but Supermemory isn't."*

## Step 2 — Ask what to configure

Available integrations (skip any already configured unless the user says they want to re-do it):

- **fal.ai** — image generation (text-to-image, image editing, lipsync, video). Has a free tier.
- **Supermemory** — persistent semantic memory across sessions. CC can search and add memories automatically.

Tavily / web search isn't on this list because Claude has built-in `WebSearch` and `WebFetch`.

Ask the user which they want to set up. Accept "all", "fal only", "memory only", "skip", etc.

## Step 3 — For each chosen integration

Repeat this loop per integration. Stay focused, finish one before starting the next.

### fal.ai

1. Tell the user: *"Open https://fal.ai/dashboard/keys, create a new key, and paste it here."*
2. Wait for the key in the next user turn. Validate that it looks like a fal credential (typically `<id>:<secret>` format, or starts with `fal_`). If it doesn't, ask them to double-check before continuing.
3. Save it to `~/.cookiedclaw/keys.env` as `FAL_KEY=<value>`:
   - `mkdir -p ~/.cookiedclaw` first.
   - If the file already has a `FAL_KEY=` line, replace it (use `Edit`); otherwise append.
   - `chmod 600 ~/.cookiedclaw/keys.env` so only the user can read it.
4. Register an MCP server for it. **You don't have to memorize the canonical package** — use `WebSearch` for "fal.ai MCP server claude code" or check `npm` to find the current best option, then propose to the user before running. Typical shape:
   ```
   claude mcp add fal -s user -e FAL_KEY=<value> -- npx -y <package-name>
   ```
   `-s user` makes it available in every CC session, not just this project.
5. Confirm: *"fal.ai is set up. Restart Claude Code, then the Telegram bot can generate images."*

### Supermemory

1. Tell the user: *"Open https://supermemory.ai, sign up if you haven't, and copy your API key from the dashboard."*
2. Wait for the key. Save to `~/.cookiedclaw/keys.env` as `SUPERMEMORY_API_KEY=<value>` (same pattern as above).
3. Register MCP server. Look up the canonical package (Supermemory ships one — likely `@supermemory/mcp` or via their hosted endpoint). Confirm with the user before running.
4. Confirm: *"Supermemory is set up. Memories will persist across sessions and across the Telegram bot."*

## Step 4 — Wrap up

After all chosen integrations are done:

- Summarize in one short list what got set up.
- Tell the user: **restart Claude Code** for new MCP servers to load. The Telegram bot keeps running independently (different process); restart only affects what *you* see in the terminal session.
- Mention `~/.cookiedclaw/keys.env` is where their keys live (chmod 600). They can edit it directly later if they need to rotate keys.
- If they set up nothing, say so and offer to come back later by re-running `/cookiedclaw-setup`.

## Don'ts

- Don't auto-run `claude mcp add` without confirming the package name + command with the user first.
- Don't commit `~/.cookiedclaw/keys.env` anywhere or copy it into the project tree.
- Don't echo API keys back in confirmation messages — say *"saved"*, not *"saved FAL_KEY=fal_abc123…"*.
- Don't try to set up integrations that aren't on the list. If the user asks for something else (Notion, GitHub, etc.), tell them to use `claude mcp add` directly or look for an existing plugin via `claude plugin marketplace`.
