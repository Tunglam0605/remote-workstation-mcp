#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 5 ]]; then
  echo "usage: ros2-python-run.sh <distro-setup-or-empty> <workspace-setup-or-empty> <domain-id-or-empty> <python-helper> <helper-args...>" >&2
  exit 64
fi

distro_setup="$1"
workspace_setup="$2"
domain_id="$3"
python_helper="$4"
shift 4

if [[ -n "$distro_setup" ]]; then
  [[ -f "$distro_setup" ]] || { echo "ROS 2 distro setup not found: $distro_setup" >&2; exit 66; }
  # shellcheck disable=SC1090
  source "$distro_setup"
fi

if [[ -n "$workspace_setup" ]]; then
  [[ -f "$workspace_setup" ]] || { echo "ROS 2 workspace setup not found: $workspace_setup" >&2; exit 66; }
  # shellcheck disable=SC1090
  source "$workspace_setup"
fi

if [[ -n "$domain_id" ]]; then
  export ROS_DOMAIN_ID="$domain_id"
fi

exec python3 "$python_helper" "$@"
