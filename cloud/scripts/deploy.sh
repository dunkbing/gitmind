#!/usr/bin/env bash
# Deploys memory-go cloud to your Cloudflare account. Safe to re-run.
#
#   GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... ./scripts/deploy.sh
#
# Needs: Wrangler signed in (`bunx wrangler login`, or CLOUDFLARE_API_TOKEN),
# the Workers Paid plan (for Artifacts), and PUBLIC_URL / routes in
# wrangler.jsonc set to your domain. See README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
W="bunx wrangler"
command -v bun >/dev/null || W="npx wrangler"

$W whoami >/dev/null || { echo "Sign in first: bunx wrangler login (or set CLOUDFLARE_API_TOKEN)"; exit 1; }

if grep -q REPLACE_WITH_D1_ID wrangler.jsonc; then
	echo "== creating the D1 database"
	$W d1 create memory-go >/dev/null 2>&1 || true
	id=$($W d1 info memory-go --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).uuid))')
	sed -i.bak "s/REPLACE_WITH_D1_ID/$id/" wrangler.jsonc && rm wrangler.jsonc.bak
fi

if grep -q REPLACE_WITH_KV_ID wrangler.jsonc; then
	echo "== creating the KV namespace for OAuth"
	$W kv namespace create memory-go-oauth >/dev/null 2>&1 || true
	id=$($W kv namespace list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("["))).find(n=>n.title.endsWith("memory-go-oauth")).id))')
	sed -i.bak "s/REPLACE_WITH_KV_ID/$id/" wrangler.jsonc && rm wrangler.jsonc.bak
fi

if [ -n "${GITHUB_CLIENT_ID:-}" ]; then
	sed -i.bak "s/\"GITHUB_CLIENT_ID\": \"[^\"]*\"/\"GITHUB_CLIENT_ID\": \"$GITHUB_CLIENT_ID\"/" wrangler.jsonc && rm wrangler.jsonc.bak
fi
grep -q REPLACE_WITH_GITHUB_CLIENT_ID wrangler.jsonc && { echo "Set GITHUB_CLIENT_ID (see README.md)"; exit 1; }

echo "== applying database migrations"
$W d1 migrations apply DB --remote

echo "== deploying"
$W deploy

if [ -n "${GITHUB_CLIENT_SECRET:-}" ]; then
	echo "== storing the GitHub client secret"
	printf '%s' "$GITHUB_CLIENT_SECRET" | $W secret put GITHUB_CLIENT_SECRET
fi
url=$(node -e 'console.log(require("fs").readFileSync("wrangler.jsonc","utf8").match(/"PUBLIC_URL":\s*"([^"]+)"/)[1])')
echo
echo "Deployed. Open $url, and connect AI apps to $url/mcp"
