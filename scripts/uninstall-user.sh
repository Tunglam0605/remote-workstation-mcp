#!/usr/bin/env bash
set -euo pipefail

DATA_HOME="${RWMCP_HOME:-$HOME/.local/share/remote-workstation-mcp}"
CONFIG_HOME="${RWMCP_CONFIG_HOME:-$HOME/.config/remote-workstation-mcp}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/remote-workstation-mcp.service"
UPDATE_SERVICE="$SERVICE_DIR/remote-workstation-mcp-update.service"
UPDATE_TIMER="$SERVICE_DIR/remote-workstation-mcp-update.timer"
PURGE=false
YES=false

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=true ;;
    --yes) YES=true ;;
    -h|--help)
      cat <<EOF
Usage: bash scripts/uninstall-user.sh [--purge --yes]

Default: stop/disable Remote Workstation MCP and remove user systemd units,
         but preserve installed versions, configuration and audit data.

--purge --yes: additionally delete:
  $DATA_HOME
  $CONFIG_HOME
EOF
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$PURGE" == true && "$YES" != true ]]; then
  echo "Refusing destructive purge without --yes." >&2
  echo "Run again with: --purge --yes" >&2
  exit 2
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now remote-workstation-mcp-update.timer 2>/dev/null || true
  systemctl --user stop remote-workstation-mcp-update.service 2>/dev/null || true
  systemctl --user disable --now remote-workstation-mcp.service 2>/dev/null || true
fi

rm -f "$SERVICE_FILE" "$UPDATE_SERVICE" "$UPDATE_TIMER"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  systemctl --user reset-failed remote-workstation-mcp.service remote-workstation-mcp-update.service 2>/dev/null || true
fi

if [[ "$PURGE" == true ]]; then
  rm -rf "$DATA_HOME" "$CONFIG_HOME"
  echo "Remote Workstation MCP uninstalled and local data/config purged."
else
  echo "Remote Workstation MCP service disabled and user units removed."
  echo "Preserved data:   $DATA_HOME"
  echo "Preserved config: $CONFIG_HOME"
  echo "Use --purge --yes only if you intentionally want to delete them."
fi
