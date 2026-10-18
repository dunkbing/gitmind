#!/bin/sh
# Installs the latest gitmind release:
#   curl -fsSL https://gitmind.app/install.sh | sh
# Set GITMIND_INSTALL_DIR to install somewhere other than ~/.local/bin.
set -eu

repo=dunkbing/gitmind
dir=${GITMIND_INSTALL_DIR:-$HOME/.local/bin}

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $os in
	darwin | linux) ;;
	*) echo "gitmind supports macOS and Linux; this is $os." >&2; exit 1 ;;
esac
case $(uname -m) in
	x86_64 | amd64) arch=amd64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) echo "No gitmind build for $(uname -m)." >&2; exit 1 ;;
esac

asset="gitmind_${os}_${arch}.tar.gz"
base="https://github.com/$repo/releases/latest/download"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset…"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"
(
	cd "$tmp"
	grep " $asset\$" checksums.txt > expected || { echo "checksums.txt has no entry for $asset" >&2; exit 1; }
	if command -v sha256sum >/dev/null 2>&1; then sha256sum -c expected >/dev/null; else shasum -a 256 -c expected >/dev/null; fi
) || { echo "The download doesn't match its checksum; not installing it." >&2; exit 1; }

tar -xzf "$tmp/$asset" -C "$tmp" gitmind
mkdir -p "$dir"
mv "$tmp/gitmind" "$dir/gitmind"
chmod 755 "$dir/gitmind"
echo "✓ Installed $("$dir/gitmind" version) to $dir/gitmind"

case ":$PATH:" in
	*":$dir:"*) ;;
	*) echo "  $dir isn't on your PATH; add it in your shell profile:  export PATH=\"$dir:\$PATH\"" ;;
esac
echo "Next: gitmind setup"
