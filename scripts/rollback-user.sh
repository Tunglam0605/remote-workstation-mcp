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
systemctl --user restart remote-workstation-mcp.service
sleep 1
curl --fail --silent http://127.0.0.1:8765/healthz || {
  echo "Rollback target failed health check." >&2
  exit 1
}
echo
echo "Rolled back to: $TARGET"
