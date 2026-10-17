#!/usr/bin/env bash
# Runs a command (e.g. `bun run test`) in the dev container, for hosts whose
# glibc is too old for Cloudflare's workerd runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -q -t memory-go-cloud-dev -f scripts/Dockerfile.dev scripts >/dev/null
exec docker run --rm -i -v "$PWD:/app" -u "$(id -u):$(id -g)" -e HOME=/tmp \
  ${PORT:+-p "$PORT:$PORT"} memory-go-cloud-dev "$@"
