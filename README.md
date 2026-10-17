# memory-go

Persistent memory for coding agents (Claude Code, Codex, anything that speaks
MCP), stored as Markdown notes in a git repository and synced between machines
through a remote such as a private GitHub repo.

Each machine runs `memory-go` as a local stdio MCP server. There is no central
server: your agents keep using their normal logins (including Claude Max), and
git does the syncing.

```
Claude Code / Codex ──stdio──▶ memory-go
                                 ├─ ~/.memory-go/**/*.md        notes (git working tree)
                                 └─ ~/.memory-go/.memory-go/    search index + lock (not in git)
                                        │
                                 commit on every write · pull at startup · push in the background
                                        ▼
                                 private GitHub repo
```

## Cloud

[`cloud/`](cloud/README.md) is a hosted version you can self-host on
Cloudflare (AGPL-3.0): the same memory over a remote MCP endpoint for
claude.ai, ChatGPT and mobile apps, a web app, chat-history import and team
workspaces. Laptops sync with it through this CLI:
`memory-go setup --cloud https://YOUR-DOMAIN`.

## Install

```bash
go install github.com/dunkbing/memory-go@latest
memory-go setup
```

`setup` logs you in to GitHub (it copies a one-time code and opens
github.com/login/device in your browser; over SSH it prints the link to open on
any device), then connects `~/.memory-go` to your `memory-notes` repository,
creating it as a private repository if it doesn't exist yet. Run the same
command on every machine. `--repo NAME` or `--repo OWNER/NAME` picks another
repository.

memory-go handles git authentication for the notes repository itself (it's
registered as git's credential helper for that repository only), so pushes
work without `gh` or SSH keys. `memory-go auth status|logout` manages the login,
saved in your user config directory, readable only by you.

Prefer your own git setup? `memory-go init <git-url>` clones any remote and
uses your existing git credentials instead.

### Claude Code

```bash
claude mcp add --scope user memory-go -- memory-go
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.memory-go]
command = "memory-go"
```

Then append [AGENT_MEMORY.md](AGENT_MEMORY.md) to `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md` so agents know when to search and save.

### Hooks (Claude Code)

Two hooks make memory automatic. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "memory-go context", "timeout": 30 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "memory-go nudge", "timeout": 10 }] }
    ]
  }
}
```

- **`memory-go context`** (recall) loads pinned notes in full, plus a one-line
  index of the current project's notes, your `general/` notes and recent
  activity elsewhere. The project is the git repository's name (the main
  checkout's name inside a worktree). Output stays under Claude Code's
  10,000-character hook limit; whatever doesn't fit is counted, with a pointer
  to `list_notes`.
- **`memory-go nudge`** (capture): when the agent is about to stop after 10 or
  more tool calls with no memory write, it's reminded once to save what's worth
  keeping, and told to save nothing rather than noise. `--threshold N` changes
  the bar.

Agents without hooks (e.g. Codex) can call the `project_context` tool instead,
as AGENT_MEMORY.md tells them to.

## Tools

| Tool | What it does |
|---|---|
| `search_notes` | Full-text search (SQLite FTS5, BM25; title > tags > body; notes with every word first, recent notes slightly favoured), filterable by directory, tags (frontmatter or inline `#tags`), observation category (`[decision]`, shown line by line) and update date (`since: 7d`) |
| `read_note` | Read a note by path, permalink or title, with its backlinks |
| `build_context` | A note plus the notes it links to and from, and links to notes not written yet (`depth: 2` goes one step further) |
| `project_context` | A project's notes, general notes and recent activity, for the start of a session |
| `write_note` | Create a note (the reply lists possibly overlapping notes, to merge instead of duplicating); replacing an existing one needs `overwrite: true` |
| `pin_note` | Show a note in full at every session start (or unpin it) |
| `edit_note` | `append`, `prepend`, `find_replace`, or `replace_section` (everything under a heading, added if missing) |
| `move_note` | New directory and/or title; links to the note are updated, and git history follows the rename |
| `delete_note` | Delete a note (git history keeps it) |
| `recent_activity` | Most recently changed notes |
| `list_notes` | List notes, optionally under one directory |
| `sync_memory` | Pull and push now |

## Syncing

- **Startup and every 3 minutes** (in the background): commits stray local
  edits (e.g. made in Obsidian), pulls, pushes.
- **Every write:** committed immediately; pushed after 5 seconds of quiet and
  again when the session ends.
- **Conflicts:** `*.md` uses git's `union` merge driver, so two machines
  appending to the same note keep both sides. If a merge still conflicts, the
  files are committed with conflict markers (nothing is lost) and the sync
  result names them.
- **Secrets:** writes that look like API keys, tokens or private keys are
  rejected, because git history would keep them forever.

## CLI

```
memory-go [--dir DIR] [--sync-interval 3m] [setup|auth|serve|context|nudge|init [REMOTE]|sync|reindex|search QUERY|recent [N]|version]
```

The notes directory defaults to `$MEMORY_GO_DIR`, then `~/.memory-go`.
Notes use the same frontmatter and `- [category] fact #tag` / `[[Link]]` style
as Basic Memory, so the folder opens as an Obsidian vault. Two frontmatter
flags are special: `pinned: true` shows the note in full at session start, and
`locked: true` marks a note you maintain by hand, which agents can't edit,
move, overwrite or delete. Links resolve by
file name or title (`[[Auth service]]`), or by path (`[[ops/runbook]]`); a list
line like `- depends on [[Auth service]]` records "depends on" as the relation.

## Limitations

- Keyword search only, no embeddings yet.
- "Updated" times come from git: the last commit touching a note, or the file
  time while it has uncommitted edits.
- macOS and Linux only (uses `flock`).

## Development

The GitHub login uses the device flow of a GitHub OAuth App (device flow
enabled, no client secret needed). Its client ID is public and set in
`auth.go`; forks can override it with `MEMORY_GO_GITHUB_CLIENT_ID`.
