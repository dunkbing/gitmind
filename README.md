# gitmind

Persistent memory for coding agents (Claude Code, Codex, anything that speaks
MCP), stored as Markdown notes in a git repository and synced between machines
through a remote such as a private GitHub repo.

Each machine runs `gitmind` as a local stdio MCP server. There is no central
server: your agents keep using their normal logins (including Claude Max), and
git does the syncing.

```
Claude Code / Codex ──stdio──▶ gitmind
                                 ├─ ~/.gitmind/**/*.md        notes (git working tree)
                                 └─ ~/.gitmind/.gitmind/    search index + lock (not in git)
                                        │
                                 commit on every write · pull at startup · push in the background
                                        ▼
                                 private GitHub repo
```

## Cloud

[`cloud/`](cloud/README.md) is a hosted version you can self-host on
Cloudflare (AGPL-3.0): the same memory over a remote MCP endpoint for
claude.ai, ChatGPT and mobile apps, a web app, chat-history import and team
workspaces. Laptops sync with it through this CLI: `gitmind setup`, or
`gitmind setup --server https://YOUR-DOMAIN` for a self-hosted server.

## Install

```bash
curl -fsSL https://gitmind.app/install.sh | sh    # or: go install github.com/dunkbing/gitmind@latest
gitmind setup
```

`gitmind update` installs the latest release later (`--check` only reports).

`setup` asks where to keep your notes: [gitmind.app](https://gitmind.app),
a private GitHub repository, a self-hosted server, or this computer only. For
gitmind.app it signs you in through your browser (over SSH it prints the link,
and you paste back the address your browser ends up on), then clones your
personal workspace into `~/.gitmind`. Run the same command on every machine. Git authentication is handled by
gitmind itself, registered as git's credential helper for that repository only.

- `--workspace SLUG`: a team workspace.
- `--server URL` (or `GITMIND_SERVER`): a [self-hosted](cloud/README.md) server.
- `--github`: no server; sync with a private `gitmind-notes` repository on your
  GitHub account (`--repo NAME` or `OWNER/NAME` picks another, and
  `gitmind auth status|logout` manages that login).
- `--local`: this computer only, no sync.
- `gitmind init <git-url>`: any git remote, with your existing git credentials.

These flags skip the question; without a terminal, setup uses gitmind.app.
Running `setup` again and choosing somewhere else switches the notes folder
over: it's backed up as `~/.gitmind.bak-DATE`, and notes missing from the new
place are copied in (differing ones are kept as `NAME-previous.md`).

`setup` then offers to add gitmind to Claude Code and Codex: the MCP server,
the Claude Code hooks below, and the memory instructions, asking before each
change. `gitmind agents` does just that step again. To do it by hand instead:

### Claude Code

```bash
claude mcp add --scope user gitmind -- gitmind
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.gitmind]
command = "gitmind"
```

Then append [AGENT_MEMORY.md](AGENT_MEMORY.md) to `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md` so agents know when to search and save.

### Hooks (Claude Code)

Two hooks make memory automatic. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "gitmind context", "timeout": 30 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "gitmind nudge", "timeout": 10 }] }
    ]
  }
}
```

- **`gitmind context`** (recall) loads pinned notes in full, plus a one-line
  index of the current project's notes, your `general/` notes and recent
  activity elsewhere. The project is the git repository's name (the main
  checkout's name inside a worktree). Output stays under Claude Code's
  10,000-character hook limit; whatever doesn't fit is counted, with a pointer
  to `list_notes`.
- **`gitmind nudge`** (capture): when the agent is about to stop after 10 or
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
gitmind [--dir DIR] [--sync-interval 3m] [setup|auth|serve|context|nudge|init [REMOTE]|sync|reindex|search QUERY|recent [N]|version]
```

The notes directory defaults to `$GITMIND_DIR`, then `~/.gitmind`.
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

Releases: push a tag like `v0.2.0`; the Release workflow builds macOS and Linux
binaries (amd64 and arm64) and publishes them with `checksums.txt`, which
`gitmind update` and the install script verify.

The GitHub login uses the device flow of a GitHub OAuth App (device flow
enabled, no client secret needed). Its client ID is public and set in
`auth.go`; forks can override it with `GITMIND_GITHUB_CLIENT_ID`.
