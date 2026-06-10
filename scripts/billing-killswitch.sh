#!/usr/bin/env bash
# billing-killswitch.sh — Stage-2 escalation tool for the June 15 billing reclassification runbook.
#
# Flips cortextos Claude-runtime PTY agents between Max OAuth (subscription) and a dedicated
# ANTHROPIC_API_KEY (capped workspace) by editing each agent's .env, which agent-pty.ts loads
# last into the PTY environment (overrides org secrets.env).
#
# THIS IS THE GREG-GATED ESCALATION LANE. The default response to reclassification is Stage 1
# (wind-down + Codex spillover) — see orgs/revops-global/RUNBOOK-billing-killswitch.md.
#
# Usage:
#   billing-killswitch.sh status                 # show per-agent billing posture
#   billing-killswitch.sh arm <sk-ant-...>       # stage a COMMENTED key block in each agent .env
#   billing-killswitch.sh fire [agent]           # uncomment the key (all agents, or one) — then restart agents
#   billing-killswitch.sh stand-down [agent]     # re-comment the key — then restart agents
#
# Restarts are intentionally NOT automatic: run `cortextos stop <agent> && cortextos start <agent>`
# after fire/stand-down, then verify with: claude -p 'ok' --output-format json (check apiKeySource).

set -euo pipefail

ORG="revops-global"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$ROOT/orgs/$ORG/agents"
MARKER="# JUNE-15-KILLSWITCH"

claude_agents() {
  # Claude-runtime agents only (codex-app-server / script runtimes don't bill Anthropic).
  for dir in "$AGENTS_DIR"/*/; do
    local name cfg
    name="$(basename "$dir")"
    cfg="$dir/config.json"
    [[ -f "$cfg" ]] || continue
    python3 - "$cfg" <<'PY' || continue
import json, sys
c = json.load(open(sys.argv[1]))
rt = c.get("runtime", "claude-code")
sys.exit(0 if rt == "claude-code" else 1)
PY
    echo "$name"
  done
}

env_file() { echo "$AGENTS_DIR/$1/.env"; }

cmd_status() {
  printf "%-16s %-10s %s\n" "AGENT" "ENABLED" "BILLING (.env)"
  for a in $(claude_agents); do
    local f enabled posture
    f="$(env_file "$a")"
    enabled="$(python3 -c "import json;print(json.load(open('$AGENTS_DIR/$a/config.json')).get('enabled', True))")"
    if [[ ! -f "$f" ]]; then
      posture="no .env"
    elif grep -qE "^ANTHROPIC_API_KEY=" "$f"; then
      posture="API KEY ACTIVE (fired)"
    elif grep -qE "^#\s*ANTHROPIC_API_KEY=" "$f" && grep -q "$MARKER" "$f"; then
      posture="armed (key staged, commented)"
    else
      posture="OAuth / subscription"
    fi
    printf "%-16s %-10s %s\n" "$a" "$enabled" "$posture"
  done
}

cmd_arm() {
  local key="${1:?usage: billing-killswitch.sh arm <sk-ant-...>}"
  [[ "$key" == sk-ant-* ]] || { echo "refusing: key does not look like an Anthropic API key (sk-ant-*)" >&2; exit 1; }
  for a in $(claude_agents); do
    local f; f="$(env_file "$a")"
    [[ -f "$f" ]] || { echo "skip $a (no .env)"; continue; }
    if grep -q "$MARKER" "$f"; then echo "skip $a (already armed)"; continue; fi
    {
      echo ""
      echo "$MARKER: Stage-2 escalation only (see orgs/$ORG/RUNBOOK-billing-killswitch.md)."
      echo "$MARKER: uncomment via 'billing-killswitch.sh fire', then restart the agent."
      echo "# ANTHROPIC_API_KEY=$key"
    } >> "$f"
    echo "armed $a"
  done
}

toggle() {
  local mode="$1" target="${2:-}"
  for a in $(claude_agents); do
    [[ -n "$target" && "$a" != "$target" ]] && continue
    local f; f="$(env_file "$a")"
    [[ -f "$f" ]] && grep -q "$MARKER" "$f" || { [[ -n "$target" ]] && echo "skip $a (not armed)"; continue; }
    if [[ "$mode" == "fire" ]]; then
      sed -i.bak -E 's|^#[[:space:]]*(ANTHROPIC_API_KEY=)|\1|' "$f" && rm -f "$f.bak"
      echo "FIRED $a -> API key active. Now: cortextos stop $a && cortextos start $a"
    else
      sed -i.bak -E 's|^(ANTHROPIC_API_KEY=)|# \1|' "$f" && rm -f "$f.bak"
      echo "stood down $a -> OAuth. Now: cortextos stop $a && cortextos start $a"
    fi
  done
}

case "${1:-}" in
  status)     cmd_status ;;
  arm)        shift; cmd_arm "$@" ;;
  fire)       shift || true; toggle fire "${1:-}" ;;
  stand-down) shift || true; toggle stand-down "${1:-}" ;;
  *) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20; exit 1 ;;
esac
