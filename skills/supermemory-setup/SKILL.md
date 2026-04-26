---
name: supermemory-setup
description: Wires up Supermemory for cross-session semantic memory in cookiedclaw. Saves SUPERMEMORY_CC_API_KEY to ./.cookiedclaw/keys.env, installs the official Supermemory plugin, and helps export the key into the user's shell so CC picks it up at startup. Requires a Supermemory Pro plan.
disable-model-invocation: true
allowed-tools: Bash(claude plugin *) Bash(mkdir *) Bash(chmod *) Bash(test *) Bash(pwd) Bash(echo $SHELL) Read Write Edit WebFetch
---

# Supermemory integration

Standalone setup for Supermemory — cross-session semantic memory that auto-captures context for the agent. The user runs this when they want "the bot to remember stuff across days" or "actually retain memory" beyond what the workspace files (IDENTITY/USER/SOUL.md) already do.

This skill is **independent** from `/cookiedclaw:setup`. If the workspace doesn't exist yet, point the user at `/cookiedclaw:setup` first.

> [!IMPORTANT]
> Supermemory **requires a Supermemory Pro plan**. Mention this BEFORE the user signs up if they don't already have one. Free-tier accounts will get a permission error from the plugin.

## Step 1 — Check workspace + existing config

Run `pwd` and confirm a cookiedclaw workspace (`./.cookiedclaw/` directory). If not:

> *"This doesn't look like a cookiedclaw workspace yet. Run `/cookiedclaw:setup` first to bootstrap one, then come back here."*

Check current state:

- `./.cookiedclaw/keys.env` — does it already have `SUPERMEMORY_CC_API_KEY`?
- `claude plugin list --json` — is `claude-supermemory` already installed and enabled?
- `echo $SUPERMEMORY_CC_API_KEY` — does the shell already export it?

If all three are present, ask:

- **Question**: "Supermemory already looks set up. What now?"
- **Options**:
  - `Re-do — replace the key with a new one`
  - `Cancel — leave it as is`

## Step 2 — Confirm Pro plan

Before sending the user to grab a key, ask via `AskUserQuestion`:

- **Question**: "Supermemory's CC plugin requires a Supermemory **Pro** plan. Do you have one, or want me to walk you through signing up first?"
- **Options**:
  - `I have Pro — let's continue`
  - `I don't have Pro yet — show me the signup`
  - `Cancel — let me think about it`

For "show me signup", tell them:
> *"Open https://console.supermemory.ai/billing, pick the Pro plan. Once you're on Pro, rerun `/cookiedclaw:supermemory-setup` to continue."*

For cancel, exit cleanly.

## Step 3 — Get the API key

Tell the user:

> *"Open https://console.supermemory.ai/keys, create an API key (starts with `sm_`), and paste it here."*

Wait for the key. Light validation — it should start with `sm_` and be reasonably long. If not, ask them to double-check.

Save to `./.cookiedclaw/keys.env` as `SUPERMEMORY_CC_API_KEY=<value>` (replace existing line if present, otherwise append). `chmod 600` the file.

Don't echo the key back. Just say *"saved"*.

## Step 4 — Install the plugin

Use `AskUserQuestion`:

- **Question**: "Install the Supermemory plugin now? (Adds their marketplace to Claude Code, then installs `claude-supermemory`.)"
- **Options**:
  - `Yes, install`
  - `No, I'll do it manually later`

On yes:

```
claude plugin marketplace add supermemoryai/claude-supermemory
claude plugin install claude-supermemory
```

If marketplace already added, the first command is a no-op (fine). If plugin already installed, mention you'll skip that step.

## Step 5 — Persist the env var

Supermemory's plugin reads `SUPERMEMORY_CC_API_KEY` from the **shell environment**, not from `./.cookiedclaw/keys.env` (which is only read by the cookiedclaw channel server). For the plugin to work, the var must be exported when CC starts.

Detect the shell with `echo $SHELL`. Then `AskUserQuestion`:

- **Question**: "Where should I put `SUPERMEMORY_CC_API_KEY` so it sticks across CC restarts?"
- **Options**:
  - `Append to my shell rc (<detected rc path>)` — auto-add an `export` line. Detect:
    - `bash` → `~/.bashrc`
    - `zsh` → `~/.zshrc`
    - `fish` → `~/.config/fish/config.fish` (use `set -gx` not `export`)
  - `Show me the line, I'll do it myself` — print the export, let user decide
  - `Use ~/.supermemory-claude/settings.json instead` — point them at https://supermemory.ai/docs/integrations/claude-code

For "auto-add", append (don't overwrite) to the rc file. Check first if the line is already there to avoid duplicates.

## Step 6 — Wrap up

Confirm: *"Supermemory set up. Restart your shell (so the export picks up) and then restart Claude Code. After that, the agent has access to `mcp__claude-supermemory__*` tools and Supermemory will auto-capture context as you chat."*

Mention briefly:
- Memory is account-scoped on Supermemory's side, so all your CC sessions (cookiedclaw and otherwise) share the same memory pool.
- If you ever want to wipe memory or browse it, https://console.supermemory.ai is the dashboard.

## Don'ts

- Don't push Supermemory if the user hesitates on Pro — it really does require Pro to be useful, and a frustrated user is worse than no integration.
- Don't echo the API key back in confirmations.
- Don't run `claude plugin install` without confirming the command first.
- Don't try to put `SUPERMEMORY_CC_API_KEY` in `./.cookiedclaw/keys.env` AND skip the shell export — the cookiedclaw channel server doesn't pass keys to the plugin.
