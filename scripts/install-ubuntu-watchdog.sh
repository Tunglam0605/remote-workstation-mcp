#!/usr/bin/env bash
set -Eeuo pipefail

# Installs a user-scoped RWMCP health watchdog; never touches the tunnel secrets.
export PATH="$HOME/.local/bin:$PATH"
if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [[ -n "${XDG_RUNTIME_DIR:-}" && -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "$XDG_RUNTIME_DIR/bus" ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rwmcp-ubuntu-watchdog.py"
TARGET="$HOME/.local/libexec/rwmcp/rwmcp-ubuntu-watchdog.py"
UNIT_DIR="$HOME/.config/systemd/user"
SVC="$UNIT_DIR/rwmcp-ubuntu-watchdog.service"
TIMER="$UNIT_DIR/rwmcp-ubuntu-watchdog.timer"
[[ -f "$SOURCE" ]] || { echo "Missing watchdog script"; exit 2; }
command -v python3 >/dev/null
python3 -m py_compile "$SOURCE"
[[ -f "$UNIT_DIR/remote-workstation-mcp-openai.service" ]] || { echo "Missing Direct Node unit"; exit 2; }

install -d -m 700 "$(dirname "$TARGET")"
install -d -m 700 "$UNIT_DIR"
if [[ -e "$TARGET" ]]; then
  cp -p "$TARGET" "$TARGET.bak-$(date +%Y%m%d%H%M%S)"
fi
install -m 700 "$SOURCE" "$TARGET"
for f in "$SVC" "$TIMER"; do
  if [[ -e "$f" ]]; then cp -p "$f" "$f.bak-$(date +%Y%m%d%H%M%S)"; fi
done

cat > "$SVC" <<'EOF'
[Unit]
Description=RWMCP Ubuntu Direct Node watchdog (bounded recovery)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 %h/.local/libexec/rwmcp/rwmcp-ubuntu-watchdog.py --self-heal
Environment=PYTHONDONTWRITEBYTECODE=1
UMask=0077
NoNewPrivileges=true
TimeoutStartSec=40
EOF

cat > "$TIMER" <<'EOF'
[Unit]
Description=Periodic health checks for RWMCP Ubuntu Direct Node

[Timer]
OnCalendar=*-*-* *:0/2:00
RandomizedDelaySec=10s
AccuracySec=15s
Persistent=true
Unit=rwmcp-ubuntu-watchdog.service

[Install]
WantedBy=timers.target
EOF

chmod 600 "$SVC" "$TIMER"
systemctl --user daemon-reload
# The first run is check-only; do not arm recovery until the current runtime passes.
python3 "$TARGET" --check
systemctl --user enable --now rwmcp-ubuntu-watchdog.timer
systemctl --user is-active --quiet rwmcp-ubuntu-watchdog.timer
systemctl --user list-timers --all rwmcp-ubuntu-watchdog.timer --no-pager
echo WATCHDOG_INSTALLED
