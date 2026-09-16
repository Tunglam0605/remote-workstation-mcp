#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_HOME="${RWMCP_HOME:-$HOME/.local/share/remote-workstation-mcp}"
CONFIG_HOME="${RWMCP_CONFIG_HOME:-$HOME/.config/remote-workstation-mcp}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/remote-workstation-mcp.service"
UPDATE_SERVICE="$SERVICE_DIR/remote-workstation-mcp-update.service"
UPDATE_TIMER="$SERVICE_DIR/remote-workstation-mcp-update.timer"
DIRECT_SERVICE_FILE="$SERVICE_DIR/remote-workstation-mcp-openai.service"
DIRECT_NODE_CONFIGURED=false
[[ -f "$DIRECT_SERVICE_FILE" ]] && DIRECT_NODE_CONFIGURED=true

for command in node npm tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done

cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
echo "Installing Remote Workstation MCP v$VERSION"
if [[ -f "$ROOT/tsconfig.json" && -d "$ROOT/src" && -d "$ROOT/tests" ]]; then
  INSTALL_KIND="source"
  echo "Source checkout detected; running full validation before packaging."
  npm install --no-audit --no-fund
  npm run typecheck
  npm test
  npm run build
else
  INSTALL_KIND="prebuilt"
  echo "Prebuilt release package detected; validating packaged runtime files."
  [[ -f "$ROOT/dist/cli.js" ]] || { echo "Prebuilt release is missing dist/cli.js." >&2; exit 1; }
fi

VERSION_DIR="$DATA_HOME/versions/$VERSION"
mkdir -p "$DATA_HOME/versions" "$DATA_HOME/runtime" "$CONFIG_HOME" "$SERVICE_DIR"
chmod 700 "$DATA_HOME" "$DATA_HOME/runtime" "$CONFIG_HOME" || true
ROOT_REAL="$(readlink -f "$ROOT")"
VERSION_REAL="$(readlink -m "$VERSION_DIR")"
if [[ "$ROOT_REAL" != "$VERSION_REAL" ]]; then
  rm -rf "$VERSION_DIR"
  mkdir -p "$VERSION_DIR"
  if [[ "$INSTALL_KIND" == "source" ]]; then
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    PACK="$(npm pack --pack-destination "$TMP" --silent)"
    tar -xzf "$TMP/$PACK" --strip-components=1 -C "$VERSION_DIR"
  else
    (cd "$ROOT" && tar --exclude='./node_modules' --exclude='./.git' -cf - .) | tar -xf - -C "$VERSION_DIR"
  fi
else
  echo "Release is already located in target version slot; preserving packaged files."
fi
(
  cd "$VERSION_DIR"
  npm install --omit=dev --no-audit --no-fund --ignore-scripts
)
BUILT_VERSION="$(node "$VERSION_DIR/dist/cli.js" --version)"
[[ "$BUILT_VERSION" == "$VERSION" ]] || { echo "Installed runtime version mismatch: package=$VERSION dist=$BUILT_VERSION" >&2; exit 1; }

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
fullControl:
  allowRawShell: false
  allowHostFilesystem: false
privileged:
  allowSudo: false
  maxRuntimeMs: 600000
EOF
  chmod 600 "$CONFIG_HOME/policy.yaml"
  echo "Created safe default workspace: $WORKSPACE"
fi

if [[ ! -f "$CONFIG_HOME/hosts.yaml" ]]; then
  cat > "$CONFIG_HOME/hosts.yaml" <<EOF
version: 1
hosts: []
EOF
  chmod 600 "$CONFIG_HOME/hosts.yaml"
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
Environment=RWMCP_HOSTS=$CONFIG_HOME/hosts.yaml
Environment=RWMCP_LEASE=$DATA_HOME/runtime/permission-lease.json
Environment=RWMCP_AUDIT=$DATA_HOME/runtime/audit.jsonl
Environment=RWMCP_CLIENT_ID=local-http
Environment=RWMCP_CLIENT_TYPE=managed-http
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
  systemctl --user enable --now remote-workstation-mcp-update.timer
  if [[ "$DIRECT_NODE_CONFIGURED" == "true" ]]; then
    # Preserve Direct Node topology across upgrades: never re-enable the local-only
    # listener when the outbound OpenAI service is already configured. Restarting
    # the Direct Node is required so the current symlink change takes effect.
    systemctl --user disable --now remote-workstation-mcp.service >/dev/null 2>&1 || true
    systemctl --user enable remote-workstation-mcp-openai.service >/dev/null 2>&1 || true
    systemctl --user restart remote-workstation-mcp-openai.service
    sleep 1
    systemctl --user --no-pager --full status remote-workstation-mcp-openai.service || true
  else
    systemctl --user enable remote-workstation-mcp.service >/dev/null 2>&1 || true
    systemctl --user restart remote-workstation-mcp.service
    sleep 1
    systemctl --user --no-pager --full status remote-workstation-mcp.service || true
  fi
else
  echo "systemctl is not available; run manually:"
  echo "  RWMCP_POLICY=$CONFIG_HOME/policy.yaml RWMCP_HOSTS=$CONFIG_HOME/hosts.yaml RWMCP_LEASE=$DATA_HOME/runtime/permission-lease.json RWMCP_CLIENT_ID=local-http $NODE_BIN $DATA_HOME/current/dist/cli.js --http"
fi

echo
echo "Installed: $DATA_HOME/current -> v$VERSION"
echo "Policy:    $CONFIG_HOME/policy.yaml"
echo "SSH hosts: $CONFIG_HOME/hosts.yaml"
echo "Lease:     $DATA_HOME/runtime/permission-lease.json"
echo "Updates:   $CONFIG_HOME/update.env (default: notify)"
echo "MCP:       http://127.0.0.1:8765/mcp"
echo "Health:    http://127.0.0.1:8765/healthz"
echo "Put projects you want to expose in $WORKSPACE or edit the local policy explicitly."
