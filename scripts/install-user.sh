#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_HOME="${RWMCP_HOME:-$HOME/.local/share/remote-workstation-mcp}"
CONFIG_HOME="${RWMCP_CONFIG_HOME:-$HOME/.config/remote-workstation-mcp}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/remote-workstation-mcp.service"
UPDATE_SERVICE="$SERVICE_DIR/remote-workstation-mcp-update.service"
UPDATE_TIMER="$SERVICE_DIR/remote-workstation-mcp-update.timer"

for command in node npm tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done

cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
echo "Installing Remote Workstation MCP v$VERSION"
npm install --no-audit --no-fund
npm run build

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PACK="$(npm pack --pack-destination "$TMP" --silent)"
VERSION_DIR="$DATA_HOME/versions/$VERSION"
mkdir -p "$VERSION_DIR" "$DATA_HOME/runtime" "$CONFIG_HOME" "$SERVICE_DIR"
rm -rf "$VERSION_DIR"/*
tar -xzf "$TMP/$PACK" --strip-components=1 -C "$VERSION_DIR"
(
  cd "$VERSION_DIR"
  npm install --omit=dev --no-audit --no-fund
)

WORKSPACE="$HOME/RemoteWorkspaces"
mkdir -p "$WORKSPACE"
if [[ ! -f "$CONFIG_HOME/policy.yaml" ]]; then
  cat > "$CONFIG_HOME/policy.yaml" <<EOF
version: 1
mode: workspace
workspaces:
  - id: projects
    name: Remote Workspaces
    root: $WORKSPACE
    readOnly: false
filesystem:
  maxReadBytes: 1048576
  maxWriteBytes: 1048576
search:
  maxResults: 100
  maxFiles: 5000
  maxFileBytes: 1048576
process:
  allowExecutables: [git, node, npm, npx, python3, cmake, ninja, make]
  inheritEnv: [PATH, HOME, LANG, LC_ALL, TERM, TMPDIR, TMP, TEMP]
  maxOutputBytes: 262144
  maxRuntimeMs: 600000
tasks: {}
EOF
  chmod 600 "$CONFIG_HOME/policy.yaml"
  echo "Created safe default workspace: $WORKSPACE"
fi

if [[ ! -f "$CONFIG_HOME/update.env" ]]; then
  cat > "$CONFIG_HOME/update.env" <<EOF
# off | notify | auto_patch | auto
RWMCP_UPDATE_MODE=notify
RWMCP_UPDATE_REPO=Tunglam0605/remote-workstation-mcp
EOF
  chmod 600 "$CONFIG_HOME/update.env"
fi

if [[ -L "$DATA_HOME/current" || -e "$DATA_HOME/current" ]]; then
  CURRENT_TARGET="$(readlink -f "$DATA_HOME/current" || true)"
  if [[ -n "$CURRENT_TARGET" && -e "$CURRENT_TARGET" ]]; then
    ln -sfn "$CURRENT_TARGET" "$DATA_HOME/previous"
  fi
fi
ln -sfn "$VERSION_DIR" "$DATA_HOME/current"

NODE_BIN="$(command -v node)"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Remote Workstation MCP
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DATA_HOME/current
Environment=RWMCP_POLICY=$CONFIG_HOME/policy.yaml
Environment=RWMCP_AUDIT=$DATA_HOME/runtime/audit.jsonl
ExecStart=$NODE_BIN $DATA_HOME/current/dist/cli.js --http
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

cat > "$UPDATE_SERVICE" <<EOF
[Unit]
Description=Check/update Remote Workstation MCP
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-$CONFIG_HOME/update.env
Environment=RWMCP_HOME=$DATA_HOME
ExecStart=$NODE_BIN $DATA_HOME/current/scripts/update-user.mjs --scheduled
UMask=0077
NoNewPrivileges=true
EOF

cat > "$UPDATE_TIMER" <<EOF
[Unit]
Description=Periodic Remote Workstation MCP update check

[Timer]
OnBootSec=5m
OnUnitActiveSec=6h
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --now remote-workstation-mcp.service
  systemctl --user enable --now remote-workstation-mcp-update.timer
  sleep 1
  systemctl --user --no-pager --full status remote-workstation-mcp.service || true
else
  echo "systemctl is not available; run manually: $NODE_BIN $DATA_HOME/current/dist/cli.js --http"
fi

echo
echo "Installed: $DATA_HOME/current -> v$VERSION"
echo "Policy:    $CONFIG_HOME/policy.yaml"
echo "Updates:   $CONFIG_HOME/update.env (default: notify)"
echo "MCP:       http://127.0.0.1:8765/mcp"
echo "Health:    http://127.0.0.1:8765/healthz"
echo "Put projects you want to expose in $WORKSPACE or edit the local policy explicitly."
