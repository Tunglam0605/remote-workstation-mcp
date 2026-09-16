#!/usr/bin/env bash
set -euo pipefail
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
curl --fail --silent "http://127.0.0.1:${PORT}/healthz" || {
  echo "Rollback target failed health check." >&2
  exit 1
}
echo
echo "Rolled back to: $TARGET"
