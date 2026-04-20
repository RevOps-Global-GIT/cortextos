#!/usr/bin/env bash
# Meeting Prep cron — fires at 6am PST weekdays, invokes claude --print one-shot.
# Replaces the long-lived cortextos daemon agent. No crash recovery surface, no
# "back online" amplification, no shared context with other agents.
#
# Trigger: cortextos crontab, `CRON_TZ=America/Los_Angeles` then `0 6 * * 1-5`.
set -euo pipefail

# -------- paths --------
FRAMEWORK_ROOT=/home/cortextos/cortextos
ORG=revops-global
AGENT_NAME=meeting-prep
AGENT_DIR="$FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT_NAME"
CTX_ROOT="${CTX_ROOT:-/home/cortextos/.cortextos/cortextos1}"
LOG_DIR=/var/log/cortextos
LOG_FILE="$LOG_DIR/meeting-prep.log"
PROMPT_FILE="$AGENT_DIR/PROMPT.txt"

# -------- PATH (cron is minimal) --------
export PATH="/home/cortextos/.local/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/home/cortextos

mkdir -p "$LOG_DIR"
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) meeting-prep cron fired ===" >> "$LOG_FILE"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "FATAL: prompt file missing at $PROMPT_FILE" >> "$LOG_FILE"
  exit 1
fi

# -------- source env files (match the PTY loader in src/pty/agent-pty.ts) --------
# Order: org secrets.env (shared), then agent .env (override).
load_env_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$f"
  set +a
}
load_env_file "$FRAMEWORK_ROOT/orgs/$ORG/secrets.env"
load_env_file "$AGENT_DIR/.env"

# -------- CTX_* convenience aliases the prompt uses --------
export CTX_FRAMEWORK_ROOT="$FRAMEWORK_ROOT"
export CTX_PROJECT_ROOT="$FRAMEWORK_ROOT"
export CTX_ROOT
export CTX_ORG="$ORG"
export CTX_AGENT_NAME="$AGENT_NAME"
export CTX_TIMEZONE="America/Los_Angeles"
export TZ="America/Los_Angeles"
[[ -n "${CHAT_ID:-}" ]] && export CTX_TELEGRAM_CHAT_ID="$CHAT_ID"

# -------- sanity checks --------
missing=()
[[ -n "${BOT_TOKEN:-}" ]] || missing+=("BOT_TOKEN")
[[ -n "${CTX_TELEGRAM_CHAT_ID:-}" ]] || missing+=("CTX_TELEGRAM_CHAT_ID/CHAT_ID")
if ((${#missing[@]})); then
  echo "FATAL: missing env: ${missing[*]}" >> "$LOG_FILE"
  exit 2
fi

cd "$AGENT_DIR"

# Non-interactive claude invocation. --dangerously-skip-permissions because cron
# has no TTY for permission prompts; the original daemon agent had never_ask=[]
# and was running under bypass-permissions anyway, so behavior matches.
# Prompt on stdin to avoid arg-length limits.
claude --print \
       --dangerously-skip-permissions \
       < "$PROMPT_FILE" \
       >> "$LOG_FILE" 2>&1
exit_code=$?

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) meeting-prep cron finished (exit $exit_code) ===" >> "$LOG_FILE"
exit $exit_code
