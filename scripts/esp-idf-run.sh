#!/usr/bin/env bash
set -euo pipefail

rwmcp_idf_path="$1"
shift

rwmcp_python_env_path=""
rwmcp_skip_check_submodules=""
rwmcp_print_provenance=0

while (($#)); do
  case "$1" in
    --rwmcp-python-env-path)
      [[ $# -ge 2 ]] || { echo "Missing value for --rwmcp-python-env-path" >&2; exit 2; }
      rwmcp_python_env_path="$2"
      shift 2
      ;;
    --rwmcp-skip-check-submodules)
      [[ $# -ge 2 ]] || { echo "Missing value for --rwmcp-skip-check-submodules" >&2; exit 2; }
      [[ "$2" == "0" || "$2" == "1" ]] || { echo "Invalid --rwmcp-skip-check-submodules value" >&2; exit 2; }
      rwmcp_skip_check_submodules="$2"
      shift 2
      ;;
    --rwmcp-print-provenance)
      rwmcp_print_provenance=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      # Backward compatibility with the v0.64 helper contract:
      # unknown tokens are treated as the first idf.py argument.
      break
      ;;
  esac
done
rwmcp_idf_args=("$@")

if [[ ! -f "$rwmcp_idf_path/export.sh" || ! -f "$rwmcp_idf_path/tools/idf.py" ]]; then
  echo "Invalid ESP-IDF path: $rwmcp_idf_path" >&2
  exit 2
fi

if [[ -n "$rwmcp_python_env_path" ]]; then
  if [[ ! -x "$rwmcp_python_env_path/bin/python" ]]; then
    echo "Invalid ESP-IDF Python environment: $rwmcp_python_env_path" >&2
    exit 2
  fi
  export IDF_PYTHON_ENV_PATH="$rwmcp_python_env_path"
fi

if [[ "$rwmcp_skip_check_submodules" == "1" ]]; then
  export IDF_SKIP_CHECK_SUBMODULES=1
elif [[ "$rwmcp_skip_check_submodules" == "0" ]]; then
  unset IDF_SKIP_CHECK_SUBMODULES || true
fi

# ESP-IDF's export.sh is sourced in-process and may define/unset generic variable
# names. Preserve the RWMCP path and argv under collision-resistant names first.
# shellcheck disable=SC1090
source "$rwmcp_idf_path/export.sh" >/dev/null

if [[ "$rwmcp_print_provenance" == "1" ]]; then
  python - <<'PY'
import json
import os
import platform
import sys

print(json.dumps({
    "pythonExecutable": sys.executable,
    "pythonVersion": platform.python_version(),
    "pythonEnvPath": os.environ.get("IDF_PYTHON_ENV_PATH"),
    "idfPath": os.environ.get("IDF_PATH"),
    "idfToolsPath": os.path.abspath(os.path.expanduser(os.environ.get("IDF_TOOLS_PATH") or "~/.espressif")),
    "skipCheckSubmodules": os.environ.get("IDF_SKIP_CHECK_SUBMODULES") == "1",
}, separators=(",", ":")))
PY
  exit 0
fi

exec python "$rwmcp_idf_path/tools/idf.py" "${rwmcp_idf_args[@]}"
