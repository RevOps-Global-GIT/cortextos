#!/usr/bin/env bash
# mac-session-keepalive.sh — announce active Mac CLI sessions to the fleet board
#
# Source this file in ~/.zshrc (or ~/.bashrc) to enable session presence:
#
#   # In ~/.zshrc:
#   export SUPABASE_RGOS_URL="https://<project>.supabase.co"
#   export SUPABASE_SESSION_KEY="<anon-key>"   # narrow anon key (NOT service-role)
#   source /path/to/mac-session-keepalive.sh
#
# The script:
#  - Derives a stable session ID from the machine hostname + user
#  - Starts a background keepalive loop that fires every 120s
#  - Sends a final "ended" heartbeat on shell exit (EXIT trap)
#  - Tracks the current working directory (cwd) and shell label
#
# Requirements:
#   - cortextos CLI installed on the Mac: npm install -g cortextos
#   - SUPABASE_RGOS_URL and SUPABASE_SESSION_KEY set in env
#   - Supabase migration 20260602000001_orch_agent_heartbeats_session_fields.sql applied

_CTXS_SESSION_ID="${USER:-greg}-$(hostname -s)"
_CTXS_KEEPALIVE_PID=""

_ctxs_heartbeat() {
  local status="${1:-active}"
  local summary="${2:-}"
  local cwd_val
  cwd_val="$(pwd 2>/dev/null || echo '')"

  if ! command -v cortextos &>/dev/null; then
    return 0
  fi

  cortextos bus session-heartbeat \
    --session-id "$_CTXS_SESSION_ID" \
    --label "${USER:-greg}-mac" \
    --kind "external-cli" \
    --cwd "$cwd_val" \
    --status "$status" \
    ${summary:+--summary "$summary"} \
    2>/dev/null &
}

_ctxs_keepalive_loop() {
  while true; do
    sleep 120
    _ctxs_heartbeat "active"
  done
}

_ctxs_on_exit() {
  if [[ -n "$_CTXS_KEEPALIVE_PID" ]]; then
    kill "$_CTXS_KEEPALIVE_PID" 2>/dev/null
  fi
  _ctxs_heartbeat "ended"
  wait 2>/dev/null
}

# Only start if credentials are present; silent no-op otherwise
if [[ -n "$SUPABASE_RGOS_URL" && -n "$SUPABASE_SESSION_KEY" ]]; then
  _ctxs_heartbeat "active"

  _ctxs_keepalive_loop &
  _CTXS_KEEPALIVE_PID=$!

  trap _ctxs_on_exit EXIT
fi
