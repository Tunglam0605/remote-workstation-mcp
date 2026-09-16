#!/usr/bin/env bash
set -euo pipefail
idf_path="$1"
shift
if [[ ! -f "$idf_path/export.sh" || ! -f "$idf_path/tools/idf.py" ]]; then
  echo "Invalid ESP-IDF path: $idf_path" >&2
  exit 2
fi
# shellcheck disable=SC1090
source "$idf_path/export.sh" >/dev/null
exec python "$idf_path/tools/idf.py" "$@"
