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

## Install

Grab the binary for your machine from `dist/` (or `go build -o memory-go .`) and
put it on your `PATH`, e.g. `~/.local/bin/memory-go`. On macOS, clear the
download quarantine flag if needed: `xattr -d com.apple.quarantine memory-go`.

Point it at the notes repository once per machine (git must be able to push to
it, e.g. after `gh auth login && gh auth setup-git`, or with an SSH URL):

```bash
memory-go init https://github.com/<you>/memory-notes.git
```

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

### Automatic recall (Claude Code)

A SessionStart hook loads the current project's notes, your `general/` notes
and recent activity into every new session, so memory shows up even when the
agent forgets to search. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "memory-go context", "timeout": 30 }] }
    ]
  }
}
```

The project is the git repository's name (the main checkout's name inside a
worktree), so notes saved under that directory come back automatically.
Output stays under Claude Code's 10,000-character hook limit; notes that don't
fit are listed by title. Agents without hooks (e.g. Codex) can call the
`project_context` tool instead, as AGENT_MEMORY.md tells them to.

## Tools

| Tool | What it does |
|---|---|
| `search_notes` | Full-text search (SQLite FTS5, BM25; title > tags > body; notes with every word first, recent notes slightly favoured), filterable by directory, tags (frontmatter or inline `#tags`), observation category (`[decision]`, shown line by line) and update date (`since: 7d`) |
| `read_note` | Read a note by path, permalink or title, with its backlinks |
| `build_context` | A note plus the notes it links to and from, and links to notes not written yet (`depth: 2` goes one step further) |
| `project_context` | A project's notes, general notes and recent activity, for the start of a session |
| `write_note` | Create a note; replacing an existing one needs `overwrite: true` |
| `edit_note` | `append`, `prepend` or `find_replace` inside a note |
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
memory-go [--dir DIR] [--sync-interval 3m] [serve|context|init [REMOTE]|sync|reindex|search QUERY|recent [N]|version]
```

The notes directory defaults to `$MEMORY_GO_DIR`, then `~/.memory-go`.
Notes use the same frontmatter and `- [category] fact #tag` / `[[Link]]` style
as Basic Memory, so the folder opens as an Obsidian vault. Links resolve by
file name or title (`[[Auth service]]`), or by path (`[[ops/runbook]]`); a list
line like `- depends on [[Auth service]]` records "depends on" as the relation.

## Limitations

- Keyword search only, no embeddings yet.
- "Updated" times come from git: the last commit touching a note, or the file
  time while it has uncommitted edits.
- macOS and Linux only (uses `flock`).
