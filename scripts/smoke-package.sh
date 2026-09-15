#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
PID=""
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}
cleanup() {
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP"
}
trap cleanup EXIT

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" ]]; then
  mkdir -p "$TEMP/release"
  cd "$ROOT"
  PACK="$(npm pack --pack-destination "$TEMP/release" --silent)"
  ARCHIVE="$TEMP/release/$PACK"
elif [[ "$ARCHIVE" != /* ]]; then
  ARCHIVE="$ROOT/$ARCHIVE"
fi

[[ -f "$ARCHIVE" ]] || { echo "Package archive not found: $ARCHIVE" >&2; exit 1; }

PKG="$TEMP/package"
WORKSPACE="$TEMP/workspace"
mkdir -p "$PKG" "$WORKSPACE"
tar -xzf "$ARCHIVE" --strip-components=1 -C "$PKG"
[[ -f "$PKG/scripts/update-windows.ps1" ]] || { echo "Packed release is missing scripts/update-windows.ps1" >&2; exit 1; }
[[ -f "$PKG/scripts/install-windows-bootstrap.cmd" ]] || { echo "Packed release is missing scripts/install-windows-bootstrap.cmd" >&2; exit 1; }
(
  cd "$PKG"
  npm install --omit=dev --no-audit --no-fund
)

VERSION="$(cd "$PKG" && node -p "require('./package.json').version")"
PORT="${RWMCP_SMOKE_PORT:-18765}"
WORKSPACE_RUNTIME="$(native_path "$WORKSPACE")"
POLICY_RUNTIME="$(native_path "$TEMP/policy.yaml")"
HOSTS_RUNTIME="$(native_path "$TEMP/hosts.yaml")"
LEASE_RUNTIME="$(native_path "$TEMP/lease.json")"
AUDIT_RUNTIME="$(native_path "$TEMP/audit.jsonl")"
HEALTH_RUNTIME="$(native_path "$TEMP/health.json")"

cat > "$TEMP/policy.yaml" <<EOF
version: 1
mode: workspace
workspaces:
  - id: smoke
    root: $WORKSPACE_RUNTIME
    readOnly: false
filesystem:
  maxReadBytes: 1048576
  maxWriteBytes: 1048576
search:
  maxResults: 20
  maxFiles: 100
  maxFileBytes: 1048576
process:
  allowExecutables: [node]
  inheritEnv: [PATH, HOME, LANG]
  maxOutputBytes: 65536
  maxRuntimeMs: 30000
tasks: {}
fullControl:
  allowRawShell: false
  allowHostFilesystem: false
privileged:
  allowSudo: false
  maxRuntimeMs: 30000
EOF

cat > "$TEMP/hosts.yaml" <<EOF
version: 1
hosts: []
EOF

(
  cd "$PKG"
  RWMCP_POLICY="$POLICY_RUNTIME" \
  RWMCP_HOSTS="$HOSTS_RUNTIME" \
  RWMCP_LEASE="$LEASE_RUNTIME" \
  RWMCP_AUDIT="$AUDIT_RUNTIME" \
  RWMCP_PORT="$PORT" \
  RWMCP_CLIENT_ID=release-smoke \
  RWMCP_CLIENT_TYPE=ci-smoke \
  node dist/cli.js --http
) >"$TEMP/server.log" 2>&1 &
PID=$!

healthy=false
for _attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" > "$TEMP/health.json"; then
    healthy=true
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Packaged server exited before becoming healthy:" >&2
    cat "$TEMP/server.log" >&2
    exit 1
  fi
  sleep 0.5
done

if [[ "$healthy" != true ]]; then
  echo "Packaged server did not become healthy:" >&2
  cat "$TEMP/server.log" >&2
  exit 1
fi

node - "$HEALTH_RUNTIME" "$VERSION" <<'NODE'
const fs = require('node:fs');
const [file, expectedVersion] = process.argv.slice(2);
const health = JSON.parse(fs.readFileSync(file, 'utf8'));
if (health.ok !== true) throw new Error(`health.ok is not true: ${JSON.stringify(health)}`);
if (health.version !== expectedVersion) throw new Error(`health.version=${health.version}, expected ${expectedVersion}`);
console.log(JSON.stringify(health));
NODE

echo "Package smoke test passed for v$VERSION"
