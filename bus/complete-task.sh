#!/usr/bin/env bash
# complete-task.sh — wrapper for Node.js CLI
# Usage: complete-task.sh <id> [result_summary]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

ID="${1:-}"
RESULT="${2:-}"

if [[ -z "$ID" ]]; then
  echo "Usage: complete-task.sh <id> [result_summary]" >&2
  exit 1
fi

ARGS=("$ID")
[[ -n "$RESULT" ]] && ARGS+=(--result "$RESULT")

# Human completions via the dashboard API set CTX_AGENT_NAME=dashboard. A person
# clicking "Mark Complete" is AUTHORITATIVE and must not be blocked by the agent
# proof-gate (which exists to stop AGENTS self-completing without verifiable
# evidence). Without this, a dashboard Mark-Complete with an empty result scores
# 4/10 in task-validate and the gate hard-exits non-zero, surfacing to the user
# as a generic 500 "Failed to update task". Skip the gate for dashboard-initiated
# completions ONLY; agent completions stay gated.
[[ "${CTX_AGENT_NAME:-}" == "dashboard" ]] && ARGS+=(--override)

exec node "$CLI" bus complete-task "${ARGS[@]}"
