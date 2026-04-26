---
name: setup
description: First-run setup for cookiedclaw — wires up the required Telegram bot token, then offers optional integrations (fal.ai for image generation, Supermemory for long-term memory). Saves keys to ~/.cookiedclaw/keys.env so they survive restarts and apply across all CC sessions.
disable-model-invocation: true
allowed-tools: Bash(claude mcp *) Bash(claude plugin *) Bash(mkdir *) Bash(chmod *) Bash(test *) Bash(echo $SHELL) Read Write Edit WebSearch WebFetch
---

# cookiedclaw onboarding wizard

You are walking the user through setting up cookiedclaw. There's exactly one **required** step (the Telegram bot token — without it nothing else matters) followed by a menu of **optional** integrations they can do now or later.

Be conversational. Ask one thing at a time. Never paste API keys or tokens back to the user — they typed them, treat them as secrets. Don't echo them in confirmations.

## Step 0 — Greet the user

Before anything else, send this greeting **exactly** (the ASCII art needs the code fence so monospace renders right):

````
```
                       .-r T~``~T^ - _
                   _,r`.- '`    `'^= _^a_
                 _*",ryr^g,         __ <`=_
                z` f  gy$@'        ay_~y~.`a,
               4      `~`     w_    ~4PF    T_
              *   _          $@@F            3,
        _ __ y  y@$F   _     `~     _         $  _ _
        F*@Mg$   ~   sF~g$_      _#~~@g,  a-  `yF$@~%
       "L ~~$$      4$ya@@@      $gya@@$  4$F 4@F~ _F
        ~*ggB$       R@@g@'_    _`@@@gP    `  JPygwF
          ~~M@         `   `FN>P'   `         2=~`
             `L   4$3y                 __    yF
              ~y  %7@@               aE-~L  _F
               ~L  `~`        _      R$w*' yF
                `=_          a$$y        _*~
                  `=y_       `~PF      _=~
                     ~=ay_        __w=F`
                         ~~TYrrY^~~`

              cookiedclaw setup wizard 🍪
```

Hey! I'm your cookiedclaw setup helper.

I'll walk you through one **required** step (the Telegram bot token) and then a couple of **optional** integrations you can enable now or skip and come back to later by re-running `/cookiedclaw:setup`.

Let me peek at what's already configured...
````

Then immediately proceed to Step 1 — don't wait for the user to acknowledge.

## Step 1 — Survey current state (no questions yet)

Read `~/.cookiedclaw/keys.env` if it exists. Note presence of:

- `TELEGRAM_BOT_TOKEN` (or legacy `TELEGRAM_API_TOKEN`) — the required one
- `FAL_KEY` — optional, fal.ai
- `SUPERMEMORY_CC_API_KEY` — optional, Supermemory

Also run `claude mcp list` and `claude plugin list --json` to detect anything related (`fal`, `supermemory`, `claude-supermemory`).

Tell the user the current state in one or two sentences. Examples:
- *"Looks like nothing's configured yet — let's start with the Telegram bot."*
- *"Telegram bot is set up; fal.ai and Supermemory aren't."*
- *"Everything's already configured. Want to re-do anything?"*

## Step 2 — REQUIRED: Telegram bot token

Skip this step entirely if `TELEGRAM_BOT_TOKEN` (or `TELEGRAM_API_TOKEN`) is already in `~/.cookiedclaw/keys.env`.

Otherwise:

1. Tell the user: *"First, the Telegram bot token. This is the one thing cookiedclaw can't run without."*
2. Walk them through @BotFather:
   - Open Telegram, search for `@BotFather`
   - Send `/newbot`
   - Pick a display name (anything they want, e.g. "My cookiedclaw")
   - Pick a unique username ending in `bot` (e.g. `mycookiedclaw_bot`)
   - BotFather replies with an HTTP API token like `123456:ABC-DEF1234ghIkl-...`
   - Paste that token into this chat
3. Wait for the token. Validate format (regex: `^\d+:[A-Za-z0-9_-]+$`). If it doesn't look right, ask them to re-check.
4. Save to `~/.cookiedclaw/keys.env` as `TELEGRAM_BOT_TOKEN=<value>`:
   - `mkdir -p ~/.cookiedclaw` first
   - If file already has a `TELEGRAM_BOT_TOKEN=` or `TELEGRAM_API_TOKEN=` line, replace it; otherwise append
   - `chmod 600 ~/.cookiedclaw/keys.env`
5. Tell the user: *"Token saved. The bot won't actually start polling until cookiedclaw restarts — we'll do that at the end after any optional integrations."*

## Step 3 — Offer optional integrations

Make it crystal clear these are **optional** — cookiedclaw works fine without them.

Use the `AskUserQuestion` tool with a multi-select question (the user picks zero, one, or multiple options at once):

- **Question**: "These are optional integrations. Which would you like to set up now? (You can always come back to `/cookiedclaw:setup` later.)"
- **Options**:
  - `fal.ai` — image generation (text-to-image, image editing, lipsync, video). Free tier available.
  - `Supermemory` — persistent semantic memory across sessions. Auto-captures context. Requires a Supermemory Pro plan.
  - `Skip — I'll set these up later`

If the user picks "Skip" (or skips the prompt), jump straight to Step 5 (wrap-up).

Otherwise, loop through the chosen integrations in Step 4. Skip any that's already configured (per Step 1's survey) unless the user says they want to re-do it — in which case use `AskUserQuestion` again to confirm the re-do.

(Tavily / web search isn't on the list because Claude has built-in `WebSearch` and `WebFetch`.)

## Step 4 — For each chosen optional integration

Loop through whichever ones the user picked. Finish one before starting the next.

### fal.ai (optional)

1. Tell the user: *"Open https://fal.ai/dashboard/keys, create a new key, and paste it here."*
2. Wait for the key. Validate that it looks like a fal credential (typically `<id>:<secret>`, or starts with `fal_`). If it doesn't, ask them to double-check.
3. Save to `~/.cookiedclaw/keys.env` as `FAL_KEY=<value>` (replace existing line if present, otherwise append). Re-`chmod 600`.
4. Register fal.ai's hosted HTTP MCP server. Use `AskUserQuestion` first (this stores the bearer token in CC's MCP config, so it's worth a yes/no):
   - **Question**: "Register the fal.ai MCP server now? (Stores your token in CC's user-scope MCP config so every session can use it.)"
   - **Options**: `Yes, register it`, `No, I'll do it manually later`
   On yes, run:
   ```
   claude mcp add --transport http fal-ai \
     https://mcp.fal.ai/mcp \
     -s user \
     --header "Authorization: Bearer <value>"
   ```
   `-s user` makes it available in every CC session, not just this project.
5. Confirm: *"fal.ai set up. After we restart at the end, Telegram bot and CC sessions can both generate images."*

### Supermemory (optional)

Supermemory ships as a first-class CC plugin (not an MCP server) — auto-injects context, auto-captures tool usage. **Requires a Supermemory Pro plan**; mention this BEFORE the user signs up if they don't already have one.

1. Tell the user: *"Open https://console.supermemory.ai/keys, create an API key (starts with `sm_`), and paste it here."*
2. Wait for the key. Save to `~/.cookiedclaw/keys.env` as `SUPERMEMORY_CC_API_KEY=<value>` (for re-setup later).
3. Install Supermemory's official plugin. Use `AskUserQuestion` first:
   - **Question**: "Install the Supermemory plugin now? (Adds their marketplace, installs claude-supermemory.)"
   - **Options**: `Yes, install`, `No, I'll do it manually later`
   On yes, run:
   ```
   claude plugin marketplace add supermemoryai/claude-supermemory
   claude plugin install claude-supermemory
   ```
4. The plugin reads `SUPERMEMORY_CC_API_KEY` from env when CC starts. Detect the user's shell (`echo $SHELL`) and use `AskUserQuestion` to ask how to persist:
   - **Question**: "Where should I put `SUPERMEMORY_CC_API_KEY` so it sticks across CC restarts?"
   - **Options**:
     - `Append to my shell rc (<detected rc path>)` — we add an `export` line for you
     - `Show me the line, I'll do it myself` — we just print it
     - `Use ~/.supermemory-claude/settings.json instead` — point them at https://supermemory.ai/docs/integrations/claude-code
5. Confirm: *"Supermemory set up. Restart your shell (so env exports) before restarting Claude Code at the end."*

## Step 5 — Wrap up

Summarize what got configured in one short list. Then:

- If they configured the Telegram token in this session: tell them **restart Claude Code now** so the channel server picks up the token and the bot starts polling. Their Telegram bot will be live the moment CC restarts.
- If only optional integrations got added: same restart instruction, but explain it's just for those new MCP servers / plugins to load.
- Mention `~/.cookiedclaw/keys.env` is where keys live (chmod 600). They can edit it directly to rotate keys.
- If they configured nothing (just looked around): say so cheerfully and remind them `/cookiedclaw:setup` is always there.

## Don'ts

- Don't run `claude mcp add` or `claude plugin install` without confirming the exact command with the user first.
- Don't commit `~/.cookiedclaw/keys.env` anywhere or copy it into a project tree.
- Don't echo API keys / tokens back in confirmation messages — say *"saved"*, not *"saved TELEGRAM_BOT_TOKEN=123456:ABC…"*.
- Don't push optional integrations. If the user says "skip" or "later" for either fal or Supermemory, accept it and move on without asking again.
- Don't try to set up integrations not on the list. If the user asks for Notion / GitHub / etc., tell them to use `claude mcp add` directly or look for an existing plugin via `claude plugin marketplace`.
