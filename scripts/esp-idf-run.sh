#!/usr/bin/env bash
set -euo pipefail

rwmcp_idf_path="$1"
shift
rwmcp_idf_args=("$@")

if [[ ! -f "$rwmcp_idf_path/export.sh" || ! -f "$rwmcp_idf_path/tools/idf.py" ]]; then
  echo "Invalid ESP-IDF path: $rwmcp_idf_path" >&2
  exit 2
fi

# ESP-IDF's export.sh is sourced in-process and may define/unset generic variable
# names. Preserve the RWMCP path and argv under collision-resistant names first.
# shellcheck disable=SC1090
source "$rwmcp_idf_path/export.sh" >/dev/null
exec python "$rwmcp_idf_path/tools/idf.py" "${rwmcp_idf_args[@]}"
