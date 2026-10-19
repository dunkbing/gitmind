# gitmind cloud

The hosted side of [gitmind](../README.md): one memory for every AI app.
It serves your notes over MCP to apps that can't run a local binary
(claude.ai on web, desktop and mobile, ChatGPT), and is also a git remote
that your laptops' gitmind CLI syncs with.

- **Remote MCP endpoint** at `/mcp`, with OAuth 2.1 sign-in (dynamic client
  registration, PKCE), so it can be added as a custom connector in claude.ai
  and ChatGPT, or to Claude Code and Codex. Same tools as the CLI, plus
  `list_workspaces`.
- **Site and docs** (`site/`, Astro + Tailwind): static pages served as
  Worker assets, with a sitemap, structured data and `llms.txt` for search
  engines and AI assistants.
- **Web app** (`app/`, a single-page app): a note editor with Obsidian-style
  live preview and a highlighted source view (CodeMirror), autosave,
  `[[link]]` completion, a folder tree, a ⌘K palette for search, backlinks
  and outline, a link graph, import and export.
- **Semantic search**: notes are split into passages and embedded with
  Workers AI (`@cf/qwen/qwen3-embedding-0.6b`, multilingual) in the
  background after each change; vectors live in the workspace's SQLite next to the FTS index (no
  separate vector database) and search merges both rankings (reciprocal rank
  fusion). Related notes in the app come from the same vectors.
- **Provenance**: every commit names who made the change and with which app
  (the OAuth client's name, or the CLI's agent and machine).
- **Import** Claude and ChatGPT data exports, or a zip of Markdown notes.
- **Teams**: shared workspaces with invite links and owner/admin/member roles.
- **Your data is git**: every workspace is a git repository (on Cloudflare
  Artifacts); every change from any app or machine is a commit.

## How it works

```
claude.ai / Desktop / mobile / ChatGPT ──MCP + OAuth──┐
browser ──────────────────────────────────────────────┤
                                                      ▼
            Worker: OAuth server (workers-oauth-provider), MCP, web app, D1 accounts
                                                      │
                      one Durable Object per workspace (SQLite + FTS5 index)
                         │ reads/writes git with isomorphic-git
                         ▼
             Artifacts repo per workspace  ◀── git pull/push ── gitmind CLI on laptops
```

Each workspace's Durable Object keeps a search index of its notes and is the
only cloud-side writer of its repository. A change is computed from the
latest notes, committed and pushed; when a laptop pushed first, the change is
recomputed on top of it, so nothing is lost. Reads check the repository for
pushes from elsewhere at most every 2 seconds. The note format and engine
(`src/engine`) match the Go CLI's exactly.

## Self-hosting on Cloudflare

You need a Cloudflare account on the Workers Paid plan (Artifacts requires
it) and a domain on Cloudflare.

1. **Configure**: in `wrangler.jsonc`, set `PUBLIC_URL` and the `routes`
   pattern to your domain.
2. **Deploy**, either from your fork with Cloudflare Workers Builds (root
   directory `cloud`, build command `bun run build`, deploy command
   `bun run deploy`), which redeploys on every push, or by hand:
   ```bash
   bun install
   bunx wrangler login
   bun run build && bun run deploy
   ```
   The first deploy creates the D1 database and KV namespace; every deploy
   applies database migrations.

People sign in with GitHub's device flow (enter a code on github.com), using
gitmind's public OAuth App, so there's nothing to register. For the usual
redirect sign-in, create your own GitHub OAuth App with callback URL
`https://YOUR-DOMAIN/auth/github/callback` and a client secret, put its
client ID in `GITHUB_CLIENT_ID` in `wrangler.jsonc`, and run
`bunx wrangler secret put GITHUB_CLIENT_SECRET`.

Then sign in at your domain and follow its **Connect** page.

## Development

```bash
bun install
bun run build       # the marketing site and docs (site/, Astro), then the app (app/, React + CodeMirror)
(cd app && bun run dev)   # the app with hot reload, against `wrangler dev` on :8787
bun run types       # generates worker-configuration.d.ts
bun run typecheck
./scripts/in-docker.sh node node_modules/vitest/vitest.mjs run   # all tests
./scripts/e2e-cli.sh                                              # CLI ↔ cloud end-to-end
```

Tests run the Worker in workerd, with a local git server standing in for
Artifacts (`DEV_GIT_BASE`) and `/dev/login` standing in for GitHub
(`DEV_LOGIN`); never set those in production. `scripts/in-docker.sh` runs
commands in a container for hosts whose glibc is too old for workerd.

## License

AGPL-3.0-only. You may self-host and modify it; if you offer a modified
version as a service, you must publish your changes.
