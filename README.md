# gitmind

**Your AI agents stop forgetting.** One memory shared by Claude, ChatGPT,
Claude Code and Codex.

Agents write and edit notes as they work (decisions, preferences, gotchas) and
read them back in the next session, in whichever app you use. The notes are
plain Markdown in a git repository you own; open them in Obsidian if you like.

Open source (AGPL-3.0). Use [gitmind.app](https://gitmind.app), self-host the
[cloud](cloud/README.md) on Cloudflare, or sync through a private GitHub repo.

## Get started

- **claude.ai or ChatGPT**: add `https://gitmind.app/mcp` as a custom
  connector ([how](https://gitmind.app/docs/connect/)).
- **Claude Code and Codex**: install the CLI and run `gitmind setup`.

```bash
curl -fsSL https://gitmind.app/install.sh | sh    # or: go install github.com/dunkbing/gitmind@latest
gitmind setup
```

On Windows, in PowerShell: `irm https://gitmind.app/install.ps1 | iex`.
`gitmind update` installs the latest release later.

`setup` asks where to keep your notes, then offers to add gitmind to Claude Code
and Codex (asking before each change; `gitmind agents` repeats that step). Run
it on every machine. Flags skip the question:

- `--github`: sync with a private `gitmind-notes` repository on your GitHub
  account (`--repo NAME` or `OWNER/NAME` picks another).
- `--server URL`: a self-hosted server. `--workspace SLUG`: a team workspace.
- `--local`: this computer only.
- `gitmind init <git-url>`: any git remote.

Running `setup` again and choosing somewhere else switches over: the old folder
is backed up as `~/.gitmind.bak-DATE`, notes missing from the new place are
copied in, and a note both places have gains the lines and tags the old one had.
Nothing is removed.

To check it works, restart your agent in a project and ask: "What do you
remember about this project?"

## How it works

Each machine runs `gitmind` as a local stdio MCP server; git does the syncing.

```
Claude Code / Codex ──stdio──▶ gitmind
                                 ├─ ~/.gitmind/**/*.md      notes (git working tree)
                                 └─ ~/.gitmind/.gitmind/    search index + locks (not in git)
                                        │
                                 commit on every write · sync in the background
                                        ▼
                                 your git remote
```

- **Writes** are committed locally right away and pushed after 5 seconds of
  quiet. Tool calls never wait on the network.
- **Sync** runs at startup and every 3 minutes: commit stray edits (say, from
  Obsidian), pull, push. `*.md` uses git's `union` merge, so two machines
  appending to one note keep both sides.
- **Secrets**: writes that look like API keys, tokens or private keys are
  rejected, because git history would keep them.
- **Session start**: the plugin's hook runs `gitmind context`, which prints
  your standing preferences and an index of the project's notes (about 8 KB at
  most) so the agent knows what to open.

## Tools

| Tool | What it does |
|---|---|
| `search_notes` | Full-text search, filterable by directory, tags, category (`decision`, `gotcha`…) and date (`since: 7d`) |
| `read_note` | Read a note by path or title, with its backlinks |
| `write_note` | Create a note; replacing one needs `overwrite: true` |
| `edit_note` | `append`, `prepend`, `find_replace`, `replace_section`, or `supersede` (replace a fact, keeping the old one under `## History`) |
| `list_notes` | List notes, optionally under one directory |

## Notes

Notes are `.md` files with optional frontmatter. Write facts as
`- [category] fact #tag` and link with `[[Note Title]]`. Two flags are special:
`pinned: true` shows a note in full at session start, and `locked: true` marks
a note you maintain by hand, which agents can't change.

The notes directory is `$GITMIND_DIR`, or `~/.gitmind`. `gitmind import
claude-code` copies the memories Claude Code kept on this machine into notes.
Search is keyword-only locally; with gitmind cloud it adds semantic matches.

## Plugins by hand

`setup` does this for you. The plugins ([`plugins/claude-code`](plugins/claude-code),
[`plugins/codex`](plugins/codex)) bundle the MCP server, the session-start hook
and the memory instructions ([AGENT_MEMORY.md](AGENT_MEMORY.md)).

```bash
claude plugin marketplace add dunkbing/gitmind && claude plugin install gitmind@gitmind
codex plugin marketplace add dunkbing/gitmind && codex plugin add gitmind@gitmind
```

In Codex, open `/hooks` once to trust the hook. Without plugins: add the MCP
server (`claude mcp add --scope user gitmind -- gitmind`, or
`[mcp_servers.gitmind] command = "gitmind"` in `~/.codex/config.toml`), a
`SessionStart` hook running `gitmind context`, and AGENT_MEMORY.md in your
`CLAUDE.md` or `AGENTS.md`.

## Development

Release: push a tag like `v0.2.0`. The Release workflow builds macOS, Linux and
Windows binaries and publishes them with `checksums.txt`, which `gitmind update`
and the install script verify.

The GitHub login uses a GitHub OAuth App's device flow. Its client ID is public
(`auth.go`); forks can override it with `GITMIND_GITHUB_CLIENT_ID`.
