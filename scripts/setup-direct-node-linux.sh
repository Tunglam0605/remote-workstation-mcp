#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  CONTROL_PLANE_API_KEY='sk-...' ./scripts/setup-direct-node-linux.sh --tunnel-id tunnel_<id> [--name 'Ubuntu Lab'] [--port 8683]

The runtime API key is written only to ~/.config/remote-workstation-mcp/openai.env (0600).
Use one distinct OpenAI Secure MCP Tunnel ID per workstation.
EOF
}

TUNNEL_ID=""
DEVICE_NAME=""
PORT="8683"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel-id) TUNNEL_ID="${2:-}"; shift 2 ;;
    --name) DEVICE_NAME="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ "$TUNNEL_ID" =~ ^tunnel_[0-9a-f]{32}$ ]] || { echo 'A valid --tunnel-id is required.' >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || { echo 'Port must be 1024..65535.' >&2; exit 2; }
: "${CONTROL_PLANE_API_KEY:?Set CONTROL_PLANE_API_KEY in the environment for this one-time setup.}"

ROOT="${RWMCP_HOME:-$HOME/.local/share/remote-workstation-mcp}"
CONFIG="${RWMCP_CONFIG_HOME:-$HOME/.config/remote-workstation-mcp}"
CURRENT="$ROOT/current"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE="$SERVICE_DIR/remote-workstation-mcp-openai.service"
ENV_FILE="$CONFIG/openai.env"
TUNNEL_DIR="$ROOT/runtime/openai-tunnel"
TUNNEL_BIN="$TUNNEL_DIR/tunnel-client"

# User-local Node installations are common on Ubuntu engineering PCs and may not be
# present in non-interactive SSH/systemd bootstrap PATHs.
export PATH="$HOME/.local/bin:$PATH"

[[ -e "$CURRENT/dist/openai-tunnel-cli.js" ]] || { echo "Managed RWMCP install not found at $CURRENT. Run scripts/install-user.sh first." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'node is required.' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo 'systemd user services are required for managed Direct Node mode.' >&2; exit 1; }

bash "$CURRENT/scripts/install-openai-tunnel-linux.sh"
mkdir -p "$CONFIG" "$SERVICE_DIR" "$ROOT/runtime"
chmod 700 "$CONFIG" "$ROOT/runtime" || true

cat > "$ENV_FILE" <<EOF
CONTROL_PLANE_TUNNEL_ID=$TUNNEL_ID
CONTROL_PLANE_API_KEY=$CONTROL_PLANE_API_KEY
RWMCP_PORT=$PORT
RWMCP_OPENAI_TUNNEL_DIR=$TUNNEL_DIR
RWMCP_OPENAI_TUNNEL_CLIENT=$TUNNEL_BIN
RWMCP_HTTP_SCOPES=workstation.read,workstation.write,workstation.execute,workstation.admin_request
EOF
if [[ -n "$DEVICE_NAME" ]]; then
  printf 'RWMCP_DEVICE_NAME=%q\n' "$DEVICE_NAME" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

NODE_BIN="$(command -v node)"
cat > "$SERVICE" <<EOF
[Unit]
Description=Remote Workstation MCP - OpenAI Direct Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$CURRENT
EnvironmentFile=$ENV_FILE
Environment=RWMCP_POLICY=$CONFIG/policy.yaml
Environment=RWMCP_HOSTS=$CONFIG/hosts.yaml
Environment=RWMCP_LEASE=$ROOT/runtime/permission-lease.json
Environment=RWMCP_AUDIT=$ROOT/runtime/audit.jsonl
Environment=RWMCP_CLIENT_ID=openai-tunnel
Environment=RWMCP_CLIENT_TYPE=openai-secure-mcp-tunnel
ExecStart=$NODE_BIN $CURRENT/dist/openai-tunnel-cli.js
Restart=always
RestartSec=3
StartLimitIntervalSec=120
StartLimitBurst=20
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

# Direct Node owns the local MCP listener, so stop/disable the old local-only service.
systemctl --user disable --now remote-workstation-mcp.service >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now remote-workstation-mcp-openai.service
sleep 2
systemctl --user --no-pager --full status remote-workstation-mcp-openai.service || true

echo
echo "Direct Node configured."
echo "Device:    ${DEVICE_NAME:-$(hostname)}"
echo "Tunnel:    $TUNNEL_ID"
echo "MCP port:  $PORT (loopback only)"
echo "Service:   remote-workstation-mcp-openai.service"
echo "App name:  Remote Workstation - ${DEVICE_NAME:-$(hostname)}"
echo "Next: create/select a ChatGPT custom MCP app using this workstation's tunnel ID."
