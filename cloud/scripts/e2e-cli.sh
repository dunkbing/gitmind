#!/usr/bin/env bash
# End-to-end: the real Worker (wrangler dev), a local git server standing in
# for Artifacts, and the real gitmind CLI connecting with `setup --cloud`.
# Run on the host; the server side runs in the dev container (host network).
set -euo pipefail
cd "$(dirname "$0")/.."
CLI=${CLI:-../bin/gitmind}
WORK=$(mktemp -d)
BASE=http://localhost:8787
docker build -q -t gitmind-cloud-dev -f scripts/Dockerfile.dev scripts >/dev/null
docker run -d --rm --name mgc-e2e --network host -v "$PWD:/app" -u "$(id -u):$(id -g)" -e HOME=/tmp gitmind-cloud-dev sh -c '
	bun -e "import { startGitServer } from \"./test/node/git-server.ts\"; await startGitServer(18765); console.log(\"git server up\"); await new Promise(() => {});" &
	rm -rf .wrangler/state && node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --config wrangler.test.jsonc >/dev/null 2>&1
	exec node node_modules/wrangler/bin/wrangler.js dev --config wrangler.test.jsonc --port 8787 --ip 127.0.0.1 \
		--var PUBLIC_URL:http://localhost:8787 --var DEV_GIT_BASE:http://127.0.0.1:18765 --var DEV_LOGIN:1 \
		--var GITHUB_CLIENT_ID:dev --var GITHUB_CLIENT_SECRET:dev' >/dev/null
trap 'docker rm -f mgc-e2e >/dev/null 2>&1; rm -rf "$WORK"' EXIT
for i in $(seq 1 60); do curl -sf $BASE/ >/dev/null && break; sleep 1; done
curl -sf $BASE/ >/dev/null || { docker logs mgc-e2e | tail -30; exit 1; }
echo "== worker up"

export GITMIND_CLOUD_CREDENTIALS=$WORK/cloud.json GITMIND_CREDENTIALS=$WORK/github.json
mkfifo "$WORK/in"; exec 3<>"$WORK/in"
$CLI --dir "$WORK/notes" setup --cloud $BASE <&3 >"$WORK/setup.log" 2>&1 &
CLI_PID=$!
for i in $(seq 1 30); do grep -q "/authorize?" "$WORK/setup.log" && break; sleep 0.5; done
URL=$(grep -o "$BASE/authorize?[^ ]*" "$WORK/setup.log")
docker exec -w /app mgc-e2e bun scripts/e2e-browser.ts $BASE zoe "$URL"
wait $CLI_PID
echo "== setup output"; cat "$WORK/setup.log"

echo "== local notes repo"; ls -A "$WORK/notes"; git -C "$WORK/notes" remote get-url origin
echo "== write a note through the local MCP server, which pushes with the credential helper"
{ printf '%s\n' \
	'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}' \
	'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
	'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_note","arguments":{"title":"Written on a laptop","directory":"general","content":"- [setup] reached the cloud through git #e2e"}}}' \
	; sleep 6; } | $CLI --dir "$WORK/notes" --sync-interval 0 serve | grep -o '"text":"[^"]*"' | tail -1
git -C "$WORK/notes" log --oneline -3
git -C "$WORK/notes" status -sb | head -1
sleep 2.5
echo "== the cloud sees it"
SEARCH="reached the cloud" docker exec -e SEARCH -w /app mgc-e2e bun scripts/e2e-browser.ts $BASE zoe "$URL"
echo "== and a note written in the cloud reaches the laptop"
docker exec -w /app mgc-e2e bun -e "
const jar=new Map(); const go=async(u,i={})=>{const h=new Headers(i.headers); h.set('Cookie',[...jar].map(([k,v])=>k+'='+v).join('; ')); if(i.method==='POST') h.set('Origin','$BASE'); const r=await fetch(u,{...i,headers:h,redirect:'manual'}); for(const c of r.headers.getSetCookie()){const [p]=c.split(';'); const x=p.indexOf('='); jar.set(p.slice(0,x),p.slice(x+1));} return r;};
await go('$BASE/dev/login?login=zoe&next=/');
const r=await go('$BASE/w/zoe/new',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'title=From+the+web&directory=general&content=-+%5Bdecision%5D+written+in+the+browser'});
console.log('web create ->', r.status, r.headers.get('Location'));"
$CLI --dir "$WORK/notes" sync
$CLI --dir "$WORK/notes" search browser
