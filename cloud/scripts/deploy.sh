#!/usr/bin/env bash
# Deploys gitmind cloud to your Cloudflare account. Safe to re-run.
#
#   ./scripts/deploy.sh
#   GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... ./scripts/deploy.sh   # your own OAuth App
#
# Needs: Wrangler signed in (`bunx wrangler login`, or CLOUDFLARE_API_TOKEN),
# the Workers Paid plan (for Artifacts), and PUBLIC_URL / routes in
# wrangler.jsonc set to your domain. See README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
W="${WRANGLER:-bunx wrangler}"
command -v bun >/dev/null || W="${WRANGLER:-npx wrangler}"

$W whoami >/dev/null || { echo "Sign in first: bunx wrangler login (or set CLOUDFLARE_API_TOKEN)"; exit 1; }

if grep -q REPLACE_WITH_D1_ID wrangler.jsonc; then
	echo "== creating the D1 database"
	$W d1 create gitmind >/dev/null 2>&1 || true
	id=$($W d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("["))).find(d=>d.name==="gitmind").uuid))')
	sed -i.bak "s/REPLACE_WITH_D1_ID/$id/" wrangler.jsonc && rm wrangler.jsonc.bak
fi

if grep -q REPLACE_WITH_KV_ID wrangler.jsonc; then
	echo "== creating the KV namespace for OAuth"
	$W kv namespace create gitmind-oauth >/dev/null 2>&1 || true
	id=$($W kv namespace list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("["))).find(n=>n.title.endsWith("gitmind-oauth")).id))')
	sed -i.bak "s/REPLACE_WITH_KV_ID/$id/" wrangler.jsonc && rm wrangler.jsonc.bak
fi

if [ -n "${GITHUB_CLIENT_ID:-}" ]; then
	sed -i.bak "s/\"GITHUB_CLIENT_ID\": \"[^\"]*\"/\"GITHUB_CLIENT_ID\": \"$GITHUB_CLIENT_ID\"/" wrangler.jsonc && rm wrangler.jsonc.bak
fi

echo "== building the site"
(cd site && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null)

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
