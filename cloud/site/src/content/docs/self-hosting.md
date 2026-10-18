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
./scripts/deploy.sh
```

The script builds the site, creates the D1 database and KV namespace, applies
migrations and deploys. Re-run it to deploy updates.

## Sign-in

Out of the box, people sign in with GitHub's device flow (they enter a code on
github.com), using gitmind's public OAuth App, so there's nothing to register.
For the usual redirect sign-in, create a GitHub OAuth App with the callback URL
`https://YOUR-DOMAIN/auth/github/callback` and run:

```bash
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... ./scripts/deploy.sh
```

## Laptops

Point the CLI at your server: `gitmind setup --cloud https://YOUR-DOMAIN`.
