---
title: CLI and local sync
metaTitle: "Persistent memory for Claude Code and Codex: CLI and local sync"
description: "Keep a synced git clone of your memory on each machine, serve it to local agents, and add recall and save hooks to Claude Code."
section: Guides
order: 4
---

The `gitmind` CLI is a local MCP server for Claude Code and Codex. It keeps a
git clone of your memory in `~/.gitmind`, so search is instant and works
offline, and syncs with gitmind.app (or with a GitHub repository) in the
background.

## Install and connect

```bash
curl -fsSL https://gitmind.app/install.sh | sh
gitmind setup
```

The script installs the latest release for macOS or Linux into `~/.local/bin`,
after checking its checksum. On Windows, run this in PowerShell instead; it
installs into `%LOCALAPPDATA%\gitmind\bin` and adds that to your PATH:

```powershell
irm https://gitmind.app/install.ps1 | iex
```
 With Go installed you can use
`go install github.com/dunkbing/gitmind@latest` instead.

Run `gitmind update` now and then to get the latest release (`--check` only
tells you whether there is one). Restart Claude Code or Codex afterwards so
they use the new version.

`setup` asks where to keep your notes:

1. **gitmind cloud** (gitmind.app): signs you in through your browser and
   clones your workspace. Works with claude.ai, ChatGPT and mobile apps too.
2. **GitHub**: a private `gitmind-notes` repository on your GitHub account.
   Your notes never leave GitHub, but claude.ai and ChatGPT can't reach them.
3. **A self-hosted server**: your own [gitmind deployment](/docs/self-hosting/).
4. **This computer only**: no sync. Run `gitmind setup` again later to add it.

Over SSH, sign-in prints a link; after approving, paste the address your
browser ends up on back into the terminal. Ctrl+C cancels at any point.

To switch later (say from GitHub to gitmind cloud), run `gitmind setup` again
and choose the new place. It offers to move your notes folder: the old folder
is backed up as `~/.gitmind.bak-DATE`, and notes the new place doesn't have are
copied over. If a note exists in both with different content, the old version
is kept next to it as `NAME-previous.md`.

Flags skip the question, for scripts: `--server https://your-domain` (or set
`GITMIND_SERVER`), `--github`, `--local`, and `--workspace SLUG` for a team
workspace. Without a terminal, setup uses gitmind.app.

## Add it to your agents

At the end, `setup` offers to add gitmind to the coding agents it finds,
asking before each change:

- **Claude Code**: registers the gitmind MCP server for all projects, adds
  the two hooks below to `~/.claude/settings.json` (keeping a backup), and adds
  memory instructions to `~/.claude/CLAUDE.md`.
- **Codex**: adds the MCP server to `~/.codex/config.toml` and the
  instructions to `~/.codex/AGENTS.md`.
- **Claude Code's own memories**: Claude Code keeps an "auto memory" per
  project on each machine (`~/.claude/projects/*/memory`), which doesn't
  follow you anywhere else. When it finds some, setup offers to import them
  (see below).

Anything already in place is left alone. Run `gitmind agents` any time to do
this again (for example after installing Codex), or `gitmind agents --yes` to
skip the questions. Check the result with `claude mcp list`.

The hooks it adds:

- **`gitmind context`** (SessionStart) loads pinned notes and an index of the
  current project's notes (the project is the git repository's name) at the
  start of every session.
- **`gitmind nudge`** (Stop) reminds the agent once to save what it learned,
  after a stretch of 10 or more tool calls with no memory write.

## Import Claude Code's memories

```bash
gitmind import claude-code --dry-run   # list what would be imported
gitmind import claude-code             # import, after asking
```

Each memory becomes a note in its project's directory (`my-app/`, or
`general/` for what Claude Code knows about you), titled as in its
`MEMORY.md` index. Its one-line description becomes the first line, an
observation categorized by the memory's type (feedback becomes `[instruction]`,
for example), followed by its text, with `[[links]]` between memories pointing
at the new titles. Notes are tagged `claude-code`. Everything goes in one
commit; notes that already exist, or that look like they contain a secret, are
skipped, so running it again is safe.

## Syncing

Every write is committed immediately and pushed within seconds; the CLI also
pulls every 3 minutes. Two machines appending to the same note merge cleanly.
Edits you make by hand (in Obsidian, say) are committed on the next sync.

## Commands

```
gitmind [--dir DIR] setup | agents | import claude-code | update | auth | serve | context | nudge | init REMOTE | sync | reindex | search QUERY | recent [N] | version
```
