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
- **Web app**: browse, search (with tag, category and date filters), edit,
  move and pin notes; follow links and backlinks; a link graph; the change
  history; import and export.
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
2. **Deploy**:
   ```bash
   bun install
   bunx wrangler login
   ./scripts/deploy.sh
   ```
   The script creates the D1 database and KV namespace, applies migrations
   and deploys. Re-run it to deploy updates.

People sign in with GitHub's device flow (enter a code on github.com), using
gitmind's public OAuth App, so there's nothing to register. For the usual
redirect sign-in, create your own GitHub OAuth App with callback URL
`https://YOUR-DOMAIN/auth/github/callback` and a client secret, then run
`GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... ./scripts/deploy.sh`.

Then sign in at your domain and follow its **Connect** page.

## Development

```bash
bun install && (cd site && bun install)
(cd site && bun run build)   # the marketing site, docs and app.css (Astro + Tailwind)
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
