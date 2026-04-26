---
name: fal-setup
description: Wires up fal.ai for image / video generation in cookiedclaw. Saves FAL_KEY to ./.cookiedclaw/keys.env and registers fal's hosted HTTP MCP server in Claude Code's user-scope config. Run from a cookiedclaw workspace.
disable-model-invocation: true
allowed-tools: Bash(claude mcp *) Bash(mkdir *) Bash(chmod *) Bash(test *) Bash(pwd) Read Write Edit
---

# fal.ai integration

Standalone setup for the fal.ai integration. The user runs this when they want image / video generation (text-to-image, image editing, lipsync, video, etc.) available to the agent.

This skill is **independent** from `/cookiedclaw:setup` — call it when the user asks for "set up fal", "add image generation", or similar. It assumes the cookiedclaw workspace already exists (`./.cookiedclaw/` directory). If it doesn't, point the user at `/cookiedclaw:setup` first.

## Step 1 — Check workspace + existing config

Run `pwd` and confirm we're in a cookiedclaw workspace. A workspace has `./.cookiedclaw/keys.env` (or at least the `./.cookiedclaw/` directory). If not:

> *"This doesn't look like a cookiedclaw workspace yet. Run `/cookiedclaw:setup` first to bootstrap one, then come back here."*

Then check for existing config:

- `./.cookiedclaw/keys.env` — does it already have `FAL_KEY`?
- `claude mcp list` — is `fal-ai` already registered?

If both are present, ask the user with `AskUserQuestion`:

- **Question**: "fal.ai already looks set up. What now?"
- **Options**:
  - `Re-do — replace the key with a new one`
  - `Cancel — leave it as is`

If they pick cancel, exit cleanly.

## Step 2 — Get the fal key

Tell the user:

> *"Open https://fal.ai/dashboard/keys, create a new key, and paste it here."*

Wait for the key. Validate format — fal keys typically look like `<id>:<secret>` or start with `fal_`. If it doesn't match, ask them to double-check.

Save to `./.cookiedclaw/keys.env`:

- `mkdir -p ./.cookiedclaw` first if needed
- If file already has a `FAL_KEY=` line, replace it; otherwise append
- `chmod 600 ./.cookiedclaw/keys.env`

Don't echo the key value back. Just say *"saved"*.

## Step 3 — Register the fal-ai MCP server

Use `AskUserQuestion`:

- **Question**: "Register the fal.ai MCP server in Claude Code now? (Stores your token in CC's user-scope config so every session can use it.)"
- **Options**:
  - `Yes, register it`
  - `No, I'll do it manually later`

On yes, run:

```
claude mcp add --transport http fal-ai \
  https://mcp.fal.ai/mcp \
  -s user \
  --header "Authorization: Bearer <value>"
```

`-s user` makes it available in every CC session, not just this workspace.

If `fal-ai` is already registered, run `claude mcp remove fal-ai -s user` first, then re-add with the new key.

## Step 4 — Wrap up

Confirm: *"fal.ai set up. After you restart Claude Code, both this Telegram session and any other CC session can call `mcp__fal-ai__*` tools (`run_model`, `submit_job`, `recommend_model`, etc.) for image / video generation."*

Mention briefly:
- The agent can now respond to "generate an image of …" by calling `run_model` and embedding the result with `[embed:<url>]`.
- For long jobs, use `submit_job` + `check_job` so the bot doesn't block on the wait.
- `~/.cookiedclaw/keys.env` (the OLD location) is **not** read anymore — keys live in the workspace's `./.cookiedclaw/keys.env`.

## Don'ts

- Don't run `claude mcp add` without confirming the exact command first.
- Don't echo the API key back in confirmations.
- Don't try to add `fal-ai` to a project-scope (`.mcp.json`) — user-scope is correct so non-cookiedclaw sessions also benefit.
