---
title: CLI and local sync
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
go install github.com/dunkbing/gitmind@latest
gitmind setup
```

`setup` asks where to keep your notes:

1. **gitmind cloud** (gitmind.app): signs you in through your browser and
   clones your workspace. Works with claude.ai, ChatGPT and mobile apps too.
2. **GitHub**: a private `gitmind-notes` repository on your GitHub account.
   Your notes never leave GitHub, but claude.ai and ChatGPT can't reach them.
3. **A self-hosted server**: your own [gitmind deployment](/docs/self-hosting/).
4. **This computer only**: no sync. Run `gitmind setup` again later to add it.

Over SSH, sign-in prints a link; after approving, paste the address your
browser ends up on back into the terminal. Ctrl+C cancels at any point.

Flags skip the question, for scripts: `--server https://your-domain` (or set
`GITMIND_SERVER`), `--github`, `--local`, and `--workspace SLUG` for a team
workspace. Without a terminal, setup uses gitmind.app.

## Add it to your agents

```bash
claude mcp add --scope user gitmind -- gitmind
```

For Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.gitmind]
command = "gitmind"
```

## Hooks for Claude Code

Two hooks make memory automatic. In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "gitmind context", "timeout": 30 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "gitmind nudge", "timeout": 10 }] }]
  }
}
```

- **`gitmind context`** loads pinned notes and an index of the current
  project's notes (the project is the git repository's name) at the start of
  every session.
- **`gitmind nudge`** reminds the agent once to save what it learned, after a
  stretch of 10 or more tool calls with no memory write.

## Syncing

Every write is committed immediately and pushed within seconds; the CLI also
pulls every 3 minutes. Two machines appending to the same note merge cleanly.
Edits you make by hand (in Obsidian, say) are committed on the next sync.

## Commands

```
gitmind [--dir DIR] setup | auth | serve | context | nudge | init REMOTE | sync | reindex | search QUERY | recent [N]
```
