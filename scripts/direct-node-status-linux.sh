#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [[ -n "${XDG_RUNTIME_DIR:-}" && -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "$XDG_RUNTIME_DIR/bus" ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
CONFIG="${RWMCP_CONFIG_HOME:-$HOME/.config/remote-workstation-mcp}"
ROOT="${RWMCP_HOME:-$HOME/.local/share/remote-workstation-mcp}"
echo '=== Remote Workstation Direct Node ==='
if systemctl --user is-active --quiet remote-workstation-mcp-openai.service; then
  echo 'service: active'
else
  echo 'service: inactive'
fi
systemctl --user --no-pager --full status remote-workstation-mcp-openai.service 2>/dev/null | sed -n '1,12p' || true
if [[ -f "$ROOT/runtime/openai-tunnel/health-url" ]]; then
  URL="$(cat "$ROOT/runtime/openai-tunnel/health-url")"
  echo "health: $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 5 "${URL%/}/readyz" && echo
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 5 -O - "${URL%/}/readyz" && echo
  else
    echo 'No curl/wget; tunnel readiness not probed.'
  fi
fi
if [[ -f "$CONFIG/device-identity.json" ]]; then
  echo 'identity:'
  sed -E 's/("id"[[:space:]]*:[[:space:]]*")[^"]+(".*)/\1<stable-device-id>\2/' "$CONFIG/device-identity.json"
fi
