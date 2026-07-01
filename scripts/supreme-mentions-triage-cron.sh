#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
RUN_SCRIPT="$FRAMEWORK_ROOT/scripts/supreme-mentions-triage-run.sh"

if [[ ! -f "$RUN_SCRIPT" ]]; then
  echo "supreme mentions triage runner missing: $RUN_SCRIPT" >&2
  exit 127
fi

find_first_file() {
  local path
  for path in "$@"; do
    if [[ -n "${path:-}" && -f "$path" ]]; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  return 1
}

RGOS_ENV="$(find_first_file \
  "${RGOS_ROOT:-}/.env" \
  "/home/cortextos/rgos/.env" \
  "/Users/gregharned/work/rgos/.env" \
  "$FRAMEWORK_ROOT/../rgos/.env" 2>/dev/null || true)"

if [[ -n "${RGOS_ENV:-}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$RGOS_ENV"
  set +a
fi

export SUPABASE_RGOS_URL="${SUPABASE_RGOS_URL:-${SUPABASE_URL:-}}"
export SUPABASE_RGOS_SERVICE_KEY="${SUPABASE_RGOS_SERVICE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"

if [[ -z "${SLACK_CLIENT_ID:-}" || -z "${SLACK_CLIENT_SECRET:-}" ]]; then
  MCP_JSON="$(find_first_file \
    "${RGOS_ROOT:-}/.mcp.json" \
    "/home/cortextos/rgos/.mcp.json" \
    "/Users/gregharned/work/rgos/.mcp.json" \
    "$FRAMEWORK_ROOT/../rgos/.mcp.json" 2>/dev/null || true)"
  if [[ -n "${MCP_JSON:-}" ]]; then
    eval "$(
      python3 - "$MCP_JSON" <<'PY'
import json
import shlex
import sys

with open(sys.argv[1]) as handle:
    cfg = json.load(handle)

raw = cfg.get("mcpServers", {}).get("slack", {}).get("env", {}).get("SLACK_WORKSPACES", "[]")
workspace = next((entry for entry in json.loads(raw) if entry.get("workspace") == "supreme-opti"), {})

if workspace.get("client_id"):
    print(f"export SLACK_CLIENT_ID={shlex.quote(workspace['client_id'])}")
if workspace.get("client_secret"):
    print(f"export SLACK_CLIENT_SECRET={shlex.quote(workspace['client_secret'])}")
PY
    )"
  fi
fi

exec bash "$RUN_SCRIPT"
