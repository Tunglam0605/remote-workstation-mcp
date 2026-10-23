#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [[ -n "${XDG_RUNTIME_DIR:-}" && -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "$XDG_RUNTIME_DIR/bus" ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
DATA_HOME="${RWMCP_HOME:-$HOME/.local/share/remote-workstation-mcp}"
CURRENT="$DATA_HOME/current"
PREVIOUS="$DATA_HOME/previous"

if [[ ! -L "$PREVIOUS" ]]; then
  echo "No previous installation is available for rollback." >&2
  exit 1
fi

OLD_CURRENT="$(readlink -f "$CURRENT" || true)"
TARGET="$(readlink -f "$PREVIOUS")"
[[ -d "$TARGET" ]] || { echo "Previous target does not exist: $TARGET" >&2; exit 1; }

ln -sfn "$TARGET" "$CURRENT"
if [[ -n "$OLD_CURRENT" && -d "$OLD_CURRENT" ]]; then
  ln -sfn "$OLD_CURRENT" "$PREVIOUS"
fi
CONFIG_HOME="${RWMCP_CONFIG_HOME:-$HOME/.config/remote-workstation-mcp}"
PORT="${RWMCP_PORT:-}"
if [[ -z "$PORT" && -f "$CONFIG_HOME/openai.env" ]]; then
  PORT="$(sed -n 's/^RWMCP_PORT=\([0-9][0-9]*\).*$/\1/p' "$CONFIG_HOME/openai.env" | head -n1)"
fi
PORT="${PORT:-8683}"
SERVICE="remote-workstation-mcp.service"
if [[ -f "$HOME/.config/systemd/user/remote-workstation-mcp-openai.service" ]]; then
  SERVICE="remote-workstation-mcp-openai.service"
fi
systemctl --user restart "$SERVICE"
sleep 1
node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/healthz", { signal: AbortSignal.timeout(5000) }).then(async r => { const b = await r.json(); if (!r.ok || b.ok !== true) process.exitCode = 1; else console.log(JSON.stringify(b)); }).catch(() => process.exitCode = 1)' "$PORT" || {
  echo "Rollback target failed health check." >&2
  exit 1
}
echo
echo "Rolled back to: $TARGET"
