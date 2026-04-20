#!/usr/bin/env bash
# Meeting Prep cron — fires at 6am PST weekdays, invokes claude --print one-shot.
# Replaces the long-lived cortextos daemon agent. No crash recovery surface, no
# "back online" amplification, no shared context with other agents.
#
# Trigger: cortextos crontab, `CRON_TZ=America/Los_Angeles` then `0 6 * * 1-5`.
set -euo pipefail

AGENT_DIR=/home/cortextos/cortextos/orgs/revops-global/agents/meeting-prep
LOG_DIR=/var/log/cortextos
LOG_FILE="$LOG_DIR/meeting-prep.log"
PROMPT_FILE="$AGENT_DIR/PROMPT.txt"

mkdir -p "$LOG_DIR"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) meeting-prep cron fired ===" >> "$LOG_FILE"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "FATAL: prompt file missing at $PROMPT_FILE" >> "$LOG_FILE"
  exit 1
fi

cd "$AGENT_DIR"

# --print: non-interactive, stdout + exit
# --dangerously-skip-permissions: cron has no TTY for permission prompts; the
#   agent's original daemon config used `never_ask: []` + bypass-permissions
#   anyway, so behavior matches.
# Prompt on stdin to avoid arg-length limits.
claude --print \
       --dangerously-skip-permissions \
       < "$PROMPT_FILE" \
       >> "$LOG_FILE" 2>&1

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) meeting-prep cron finished (exit $?) ===" >> "$LOG_FILE"
