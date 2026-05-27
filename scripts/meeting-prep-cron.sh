#!/usr/bin/env bash
# Meeting Prep cron — fires at 6am PST weekdays and runs one bounded Codex job.
# Replaces the long-lived cortextos daemon agent without using Anthropic API
# spend or a persistent "back online" agent surface.
#
# Trigger: cortextos crontab, `CRON_TZ=America/Los_Angeles` then `0 6 * * 1-5`.
set -euo pipefail

# -------- paths --------
FRAMEWORK_ROOT=/home/cortextos/cortextos
ORG=revops-global
AGENT_NAME=meeting-prep
AGENT_DIR="$FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT_NAME"
CTX_ROOT="${CTX_ROOT:-/home/cortextos/.cortextos/cortextos1}"
LOG_DIR="${MEETING_PREP_LOG_DIR:-/var/log/cortextos}"
LOG_FILE="$LOG_DIR/meeting-prep.log"
PROMPT_FILE="${MEETING_PREP_PROMPT_FILE:-$AGENT_DIR/PROMPT.txt}"
TIMEOUT_SECONDS="${MEETING_PREP_TIMEOUT_SECONDS:-1800}"

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
if ! command -v cortextos >/dev/null 2>&1; then
  echo "FATAL: cortextos CLI not found on PATH" >> "$LOG_FILE"
  exit 2
fi

cd "$FRAMEWORK_ROOT"

# Do not pass Anthropic credentials into the bounded runner. The prompt may still
# use approved bus/GWS/local tooling, but this wrapper must not spend Claude API.
unset ANTHROPIC_API_KEY
unset CLAUDE_API_KEY

if [[ "${MEETING_PREP_DRY_RUN:-}" == "1" ]]; then
  echo "DRY RUN: would run cortextos bus spawn-codex $PROMPT_FILE" >> "$LOG_FILE"
  echo "DRY RUN: workdir=$FRAMEWORK_ROOT agent=$AGENT_NAME timeout=$TIMEOUT_SECONDS" >> "$LOG_FILE"
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) meeting-prep cron finished (dry-run) ===" >> "$LOG_FILE"
  exit 0
fi

# Bounded Codex invocation. spawn-codex captures durable markdown/JSON artifacts
# under orgs/$ORG/agents/$AGENT_NAME/output and exits non-zero on failure.
cortextos bus spawn-codex "$PROMPT_FILE" \
       --workdir "$FRAMEWORK_ROOT" \
       --agent "$AGENT_NAME" \
       --agents-root "$FRAMEWORK_ROOT/orgs/$ORG" \
       --timeout "$TIMEOUT_SECONDS" \
       --sandbox workspace-write \
       --json-output \
       >> "$LOG_FILE" 2>&1
exit_code=$?

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) meeting-prep cron finished (exit $exit_code) ===" >> "$LOG_FILE"
exit $exit_code
