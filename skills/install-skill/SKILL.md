---
name: install-skill
description: Install an agent skill from skills.sh (or any GitHub repo) into the user-global skills directory and restart the cookiedclaw daemon so the new skill becomes discoverable. Use when the user says "install skill X", "add the foo skill", or "поставь скилл на bar". Requires daemon mode enabled (`/cookiedclaw:enable-daemon`).
allowed-tools: Bash(npx --yes skills add *) Bash(npx --yes skills find *) Bash(systemctl --user restart cookiedclaw) Bash(systemctl --user is-active cookiedclaw) Bash(ls -la *) Bash(sleep 3) Bash(setsid *) Read
---

# Install a skill remotely

Installs an agent skill via the [Skills CLI](https://skills.sh/) and restarts the cookiedclaw daemon so the new skill is picked up without anyone touching the terminal.

> [!WARNING]
> `npx skills add <pkg>` runs arbitrary code from a third-party repo. The "highest install-count from a trustworthy source" heuristic below is **not** a signature check. Verify the package source before installing anything for the user when in doubt — when not in doubt (clearly named popular skills from `vercel-labs`, `anthropics`, `obra`, `microsoft`), proceed.

## Pre-flight

Confirm the daemon is up — restart only works if it's already running under systemd:

```bash
systemctl --user is-active cookiedclaw
```

If not `active`, tell the user to run `/cookiedclaw:enable-daemon` first. Without daemon mode, you can install the skill but the user has to restart CC manually.

## Pick the skill

If the user gave a precise package (e.g. `obra/superpowers@brainstorming`), use it.

If they gave a topic ("install a skill for code review"), search first:

```bash
npx --yes skills find <query>
```

Then pick the highest install-count result from a trustworthy source (`vercel-labs`, `anthropics`, `obra`, `microsoft`, …). Show the user the candidate and what it does, and ask only if it's ambiguous. Otherwise proceed.

## Install

```bash
npx --yes skills add <owner/repo>@<skill> -g -y
```

Flags:
- `-g` — install user-globally (`~/.agents/skills/`), symlinks into `~/.claude/skills/`
- `-y` — skip interactive agent-target picker

Verify the install landed:

```bash
ls -la ~/.claude/skills/<skill-name>
```

It should be a symlink pointing at `~/.agents/skills/<skill-name>`.

## Restart so the skill becomes discoverable

CC scans skills only at startup. Tell the user via Telegram what just happened, then trigger the restart in a way that gives the channel server time to flush the message before SIGTERM lands:

> ✓ Installed `<skill>`. Restarting cookiedclaw so it shows up — back in a few seconds.

Then issue the restart in a detached subshell so this skill's `await` completes before systemd kills the process:

```bash
setsid bash -c 'sleep 1; systemctl --user restart cookiedclaw' </dev/null >/dev/null 2>&1 &
```

The 1-second sleep is the safety window: this skill returns immediately, the channel server flushes the "Installed" message to Telegram, then systemd restarts everything.

After the detached restart, end your turn — don't try to send another Telegram message. The channel server is going down.

## Post-restart smoke check (next session)

The smoke check fires from the **next** session that comes up — the current process is dead by then. Add this to the end of `IDENTITY.md` or `BOOTSTRAP.md` if you want the new session to verify the skill is reachable. (Not strictly part of this skill, but a worthwhile follow-up.)

For now, the daemon's `Restart=always` policy means it'll come back up within a few seconds; the user's next DM lands in the fresh session and confirms by behaviour.

## Failure modes

- **Install errored** — show the npx output, do not restart. Skill state is unchanged.
- **Daemon not active** — install but skip restart. Tell the user the skill is on disk; they need to restart CC manually (or run `/cookiedclaw:enable-daemon` to switch to daemon mode going forward).
- **Restart succeeded but skill still not visible after restart** — most likely a name mismatch (the SKILL.md `name:` field differs from the directory name). Tell the user to check `~/.agents/skills/<dir>/SKILL.md` frontmatter.
