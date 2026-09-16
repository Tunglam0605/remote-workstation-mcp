#!/usr/bin/env bash
set -euo pipefail

REPO="${RWMCP_UPDATE_REPO:-Tunglam0605/remote-workstation-mcp}"
NODE_VERSION="${RWMCP_NODE_VERSION:-24.19.0}"
INSTALL_BASE="${RWMCP_HOME:-$HOME/.local/share/remote-workstation-mcp}"
BIN_DIR="$HOME/.local/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 1 "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 -O "$out" "$url"
  else
    echo "curl or wget is required." >&2
    exit 1
  fi
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local major
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    if [[ "$major" -ge 22 ]]; then return 0; fi
  fi

  local machine node_arch archive base node_home
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) echo "Unsupported CPU architecture for automatic Node.js install: $machine" >&2; exit 1 ;;
  esac
  archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  echo "Node.js >=22 not found. Installing Node.js v${NODE_VERSION} for this user..."
  fetch "$base/$archive" "$TMP/$archive"
  fetch "$base/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  (cd "$TMP" && grep "  $archive$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$HOME/.local" "$BIN_DIR"
  tar -xJf "$TMP/$archive" -C "$HOME/.local"
  node_home="$HOME/.local/node-v${NODE_VERSION}-linux-${node_arch}"
  ln -sfn "$node_home/bin/node" "$BIN_DIR/node"
  ln -sfn "$node_home/bin/npm" "$BIN_DIR/npm"
  ln -sfn "$node_home/bin/npx" "$BIN_DIR/npx"
  [[ -e "$node_home/bin/corepack" ]] && ln -sfn "$node_home/bin/corepack" "$BIN_DIR/corepack" || true
  export PATH="$BIN_DIR:$node_home/bin:$PATH"
}

latest_version() {
  if [[ -n "${RWMCP_VERSION:-}" ]]; then printf '%s\n' "${RWMCP_VERSION#v}"; return; fi
  local json tag
  fetch "https://api.github.com/repos/$REPO/releases/latest" "$TMP/latest.json"
  tag="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([0-9][^"]*\)".*/\1/p' "$TMP/latest.json" | head -n1)"
  [[ -n "$tag" ]] || { echo "Could not resolve the latest RWMCP release." >&2; exit 1; }
  printf '%s\n' "$tag"
}

ensure_node
VERSION="$(latest_version)"
TAG="v$VERSION"
PKG="remote-workstation-mcp-$TAG.tgz"
BASE="https://github.com/$REPO/releases/download/$TAG"

echo "Installing Remote Workstation MCP $TAG..."
fetch "$BASE/$PKG" "$TMP/$PKG"
fetch "$BASE/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt"
(cd "$TMP" && grep "  $PKG$" SHA256SUMS.txt | sha256sum -c -)
mkdir -p "$TMP/package"
tar -xzf "$TMP/$PKG" --strip-components=1 -C "$TMP/package"
export PATH="$BIN_DIR:$PATH"
bash "$TMP/package/scripts/install-user.sh"

echo
echo "Remote Workstation MCP $TAG is installed."
echo "First-time setup now needs only:"
echo "  1) Tunnel ID"
echo "  2) Runtime API key (Tunnels Read + Use)"
echo
if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v "$BIN_DIR/rwmcp-webui" >/dev/null 2>&1; then
  echo "Opening local Web Control Center: http://127.0.0.1:8684/"
  "$BIN_DIR/rwmcp-webui" >/dev/null 2>&1 &
else
  echo "Run: rwmcp-tui"
  echo "Or on a desktop: rwmcp-webui"
fi