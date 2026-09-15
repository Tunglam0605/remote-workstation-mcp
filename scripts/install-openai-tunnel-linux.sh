#!/usr/bin/env bash
set -euo pipefail

VERSION="v0.0.14"
ROOT="${RWMCP_HOME:-$HOME/.local/share/remote-workstation-mcp}"
TARGET_DIR="$ROOT/runtime/openai-tunnel"
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64)
    ARCH="amd64"
    EXPECTED_SHA="15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    EXPECTED_SHA="2de3fb879a18edb847e0313592c912f1983685488290a7fdba7ac403e6a4fb0a"
    ;;
  *) echo "Unsupported Linux architecture: $ARCH_RAW" >&2; exit 1 ;;
esac

ASSET="tunnel-client-${VERSION}-linux-${ARCH}.zip"
URL="https://github.com/openai/tunnel-client/releases/download/${VERSION}/${ASSET}"
BINARY="$TARGET_DIR/tunnel-client"
mkdir -p "$TARGET_DIR"
chmod 700 "$TARGET_DIR" || true

if [[ -x "$BINARY" ]] && "$BINARY" --version 2>&1 | grep -q '0\.0\.14'; then
  echo "OpenAI tunnel-client $VERSION already installed: $BINARY"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ZIP="$TMP/$ASSET"
EXTRACT="$TMP/extract"
mkdir -p "$EXTRACT"

echo "Downloading official OpenAI tunnel-client $VERSION for linux-$ARCH..."
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --connect-timeout 15 "$URL" -o "$ZIP"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$ZIP" "$URL"
else
  echo 'curl or wget is required.' >&2
  exit 1
fi

ACTUAL_SHA="$(sha256sum "$ZIP" | awk '{print $1}')"
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "SHA-256 mismatch for $ASSET" >&2
  echo "Expected: $EXPECTED_SHA" >&2
  echo "Actual:   $ACTUAL_SHA" >&2
  exit 1
fi
echo 'SHA-256 verified.'

if command -v unzip >/dev/null 2>&1; then
  unzip -q "$ZIP" -d "$EXTRACT"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m zipfile -e "$ZIP" "$EXTRACT"
else
  echo 'unzip or python3 is required to extract the verified archive.' >&2
  exit 1
fi

FOUND="$(find "$EXTRACT" -type f -name tunnel-client -perm -u+x -print -quit)"
if [[ -z "$FOUND" ]]; then
  FOUND="$(find "$EXTRACT" -type f -name tunnel-client -print -quit)"
fi
[[ -n "$FOUND" ]] || { echo 'Verified archive does not contain tunnel-client.' >&2; exit 1; }
install -m 700 "$FOUND" "$BINARY"
"$BINARY" --version | grep -q '0\.0\.14' || { echo 'Installed tunnel-client version check failed.' >&2; exit 1; }
echo "Installed official OpenAI tunnel-client $VERSION: $BINARY"
