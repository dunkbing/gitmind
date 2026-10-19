# gitmind

**Your AI agents stop forgetting.** One memory shared by Claude, ChatGPT,
Claude Code and Codex.

Every new agent session starts from zero, so you re-explain your stack, your
preferences and the bug you already fixed. gitmind gives all your AI apps one
memory: agents save what they learn as they work (decisions, preferences,
gotchas, how things are set up) and recall it at the start of the next
session, in whichever app you use.

- **Works in every AI app**: one MCP endpoint for claude.ai, ChatGPT, Claude
  Code and Codex, on every device. What one app learns, the others know.
- **Automatic**: in Claude Code, notes load when a session starts and the agent
  is reminded to save before it stops. Nothing to approve.
- **Facts stay current**: a changed fact moves to a dated History instead of
  contradicting the new one, and agents are warned when they save a conflict.
- **Yours, in git**: plain Markdown notes in a git repository you own. Read
  them in Obsidian, edit them, take them with you.
- **Open source** (AGPL-3.0): use [gitmind.app](https://gitmind.app),
  self-host it on Cloudflare, or sync through a private GitHub repo.

## Get started

- **claude.ai or ChatGPT**: add `https://gitmind.app/mcp` as a custom
  connector ([how](https://gitmind.app/docs/connect/)).
- **Claude Code and Codex**: install the CLI and run `gitmind setup`, which
  also installs the Claude Code plugin (see [Install](#install)).

## How the CLI works

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

On Windows, in PowerShell: `irm https://gitmind.app/install.ps1 | iex`.

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

`setup` then offers to add gitmind to Claude Code and Codex, asking before
each change. `gitmind agents` does just that step again. To do it by hand
instead:

### Claude Code

Install the plugin, which bundles the MCP server, the hooks below, and the
memory instructions as a skill ([`plugin/`](plugin)):

```
/plugin install gitmind --marketplace dunkbing/gitmind
```

From a shell, or with Claude Code older than 2.1.275:

```bash
claude plugin marketplace add dunkbing/gitmind
claude plugin install gitmind@gitmind
```

If an earlier setup added the MCP server, hooks or `CLAUDE.md` block
directly, `gitmind agents` offers to remove them; otherwise your notes load
twice. Without plugins, add the pieces yourself:
`claude mcp add --scope user gitmind -- gitmind`, the hooks below, and
AGENT_MEMORY.md in `~/.claude/CLAUDE.md`.

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.gitmind]
command = "gitmind"
```

Then append [AGENT_MEMORY.md](AGENT_MEMORY.md) to `~/.codex/AGENTS.md` so
Codex knows when to search and save. (The plugin's skill,
`plugin/skills/memory/SKILL.md`, is the same text; a test keeps them equal.)

### Hooks (Claude Code)

Two hooks make memory automatic. The plugin includes them; without it, add
to `~/.claude/settings.json`:

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

- **`gitmind context`** (recall) starts with your **profile**: the
  `[instruction]` and `[preference]` lines of your `general/` notes and the
  current project's notes (not ones under a `## History` heading), newest
  first, at most 40 and a quarter of the budget. Then pinned notes in full,
  then a one-line index of the current project's notes (up to 40), your
  `general/` notes (up to 20) and recent activity elsewhere (5). The project is the git repository's name (the main
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
| `search_notes` | Full-text search (SQLite FTS5, BM25; title > tags > body; notes with every word first, recent notes slightly favoured), filterable by directory, tags (frontmatter or inline `#tags`), observation category (`[decision]`, shown line by line) and update date (`since: 7d`); facts under `## History` only with `include_history` |
| `read_note` | Read a note by path, permalink or title, with its backlinks |
| `build_context` | A note plus the notes it links to and from, and links to notes not written yet (`depth: 2` goes one step further) |
| `project_context` | Your profile, pinned notes, and an index of a project's notes, general notes and recent activity, for the start of a session (`budget` sets the size) |
| `write_note` | Create a note (the reply lists possibly overlapping notes, to merge instead of duplicating); replacing an existing one needs `overwrite: true` |
| `pin_note` | Show a note in full at every session start (or unpin it) |
| `edit_note` | `append`, `prepend`, `find_replace`, `replace_section` (everything under a heading, added if missing), or `supersede` (replace a fact, keeping the old one under `## History` with the date) |
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
gitmind [--dir DIR] [--sync-interval 3m] [setup|agents|import claude-code|update|auth|serve|context|nudge|init [REMOTE]|sync|reindex|search QUERY|recent [N]|version]
```

`gitmind import claude-code` copies the memories Claude Code saved on this
machine (`~/.claude/projects/*/memory`, which stay on one machine) into
gitmind, one note per memory in its project's directory, in one commit;
`--dry-run` lists them first. `setup` and `agents` offer it when they find
some.

The notes directory defaults to `$GITMIND_DIR`, then `~/.gitmind`.
Notes use the same frontmatter and `- [category] fact #tag` / `[[Link]]` style
as Basic Memory, so the folder opens as an Obsidian vault. Two frontmatter
flags are special: `pinned: true` shows the note in full at session start, and
`locked: true` marks a note you maintain by hand, which agents can't edit,
move, overwrite or delete. Links resolve by
file name or title (`[[Auth service]]`), or by path (`[[ops/runbook]]`); a list
line like `- depends on [[Auth service]]` records "depends on" as the relation.

## Limitations

- The CLI's local index is keyword-only. When your notes sync with gitmind
  cloud, `search_notes` adds the cloud's semantic matches (embeddings); with
  GitHub-only sync, search is keyword-only.
- "Updated" times come from git: the last commit touching a note, or the file
  time while it has uncommitted edits.

## Development

Releases: push a tag like `v0.2.0`; the Release workflow builds macOS, Linux and
Windows binaries (amd64 and arm64) and publishes them with `checksums.txt`, which
`gitmind update` and the install script verify.

The GitHub login uses the device flow of a GitHub OAuth App (device flow
enabled, no client secret needed). Its client ID is public and set in
`auth.go`; forks can override it with `GITMIND_GITHUB_CLIENT_ID`.
