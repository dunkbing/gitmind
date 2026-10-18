---
title: Self-hosting
description: "Run your own gitmind on your Cloudflare account."
section: Reference
order: 10
---

gitmind is open source (AGPL-3.0). To run your own:

## Requirements

- A Cloudflare account on the **Workers Paid** plan (Artifacts requires it).
- A domain on Cloudflare.
- [Bun](https://bun.sh) and Node.js.

## Deploy

```bash
git clone https://github.com/dunkbing/gitmind
cd gitmind/cloud
bun install && (cd site && bun install)
# In wrangler.jsonc: set PUBLIC_URL and the routes pattern to your domain.
bunx wrangler login
bun run build && bun run deploy
```

The first deploy creates the D1 database and KV namespace; every deploy
applies database migrations. Run the same two commands to deploy updates.

To deploy on every push instead, connect your fork in the Cloudflare
dashboard (your Worker → Settings → Builds) with root directory `cloud`,
build command `bun run build` and deploy command `bun run deploy`.

## Sign-in

Out of the box, people sign in with GitHub's device flow (they enter a code on
github.com), using gitmind's public OAuth App, so there's nothing to register.
For the usual redirect sign-in, create a GitHub OAuth App with the callback URL
`https://YOUR-DOMAIN/auth/github/callback`, put its client ID in
`GITHUB_CLIENT_ID` in `wrangler.jsonc`, and store its secret:

```bash
bunx wrangler secret put GITHUB_CLIENT_SECRET
```

## Laptops

Point the CLI at your server: `gitmind setup --server https://YOUR-DOMAIN`,
or set `GITMIND_SERVER=https://YOUR-DOMAIN` once in your shell profile.
