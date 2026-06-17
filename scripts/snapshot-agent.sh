#!/usr/bin/env bash
# snapshot-agent.sh
# Takes a best-effort memory + Neon snapshot for the named agent.
# Callable on-demand by the daemon (Tier 0 auto-reset) or manually by ops.
#
# Usage:
#   snapshot-agent.sh <agent_name> [--silent] [--reason <text>]
#
# Flags:
#   --silent        Skip all user-facing notifications (Telegram). Neon + memory
#                   writes still happen. Used by daemon-triggered auto-resets
#                   so the user does not see a notification for every auto-reset.
#   --reason <txt>  Reason string recorded in the Neon episode + memory marker.
#
# Never fails the caller: all side effects wrapped, exits 0 even on partial
# failure. The caller decides whether to restart regardless of snapshot outcome.

set +e

AGENT=""
SILENT=0
REASON="auto-snapshot"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --silent) SILENT=1; shift ;;
    --reason) REASON="${2:-auto-snapshot}"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    --*)
      echo "snapshot-agent.sh: unknown flag $1" >&2
      exit 2
      ;;
    *)
      if [[ -z "$AGENT" ]]; then
        AGENT="$1"
        shift
      else
        echo "snapshot-agent.sh: unexpected positional arg $1" >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$AGENT" ]]; then
  echo "snapshot-agent.sh: agent name is required" >&2
  exit 2
fi

# Validate agent name matches [a-z0-9_-]+ to prevent shell/path injection.
if [[ ! "$AGENT" =~ ^[a-z0-9_-]+$ ]]; then
  echo "snapshot-agent.sh: invalid agent name: $AGENT" >&2
  exit 2
fi

FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/Users/loganbronstein/cortextos}"
ORG="${CTX_ORG:-cortex}"
AGENT_DIR="${CTX_AGENT_DIR:-$FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT}"
SECRETS_FILE="$FRAMEWORK_ROOT/orgs/$ORG/secrets.env"
LOG_EPISODE="$FRAMEWORK_ROOT/orgs/$ORG/agents/boss/experiments/log-episode.sh"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TODAY=$(date -u +%Y-%m-%d)
MEMORY_FILE="$AGENT_DIR/memory/$TODAY.md"

# 1. Append snapshot marker to today's memory file.
# The marker tells the post-restart session it came out of an auto-snapshot so
# it does not have to guess where the previous session left off.
mkdir -p "$AGENT_DIR/memory" 2>/dev/null

# Cap / auto-rotate ON WRITE — kills the context-bloat boot-loop failure class.
# A daily memory file that balloons (mostly self-inflicted AUTO-SNAPSHOT/Session-Start
# spam) gets re-read on every boot; once it pushes boot context past an agent's
# ctx_autoreset_threshold the daemon force-restarts, which appends ANOTHER snapshot
# and re-reads — a 2-3min restart loop (hit orchestrator + codex-3 on 2026-06-17).
# Before appending, if today's file already exceeds the cap, archive the FULL file
# (history is preserved, never deleted) and replace it with a lean stub (rotation
# pointer + recent tail). The cap is well under the lowest agent ctx_autoreset_threshold
# so a freshly-rotated file can never re-trigger a boot-time force-restart.
# Override with DAILY_MEMORY_CAP_BYTES (default 32768 = 32KB ≈ 8K tokens).
DAILY_MEMORY_CAP_BYTES="${DAILY_MEMORY_CAP_BYTES:-32768}"
DAILY_MEMORY_KEEP_TAIL_LINES="${DAILY_MEMORY_KEEP_TAIL_LINES:-40}"
if [[ -f "$MEMORY_FILE" ]]; then
  CUR_BYTES=$(wc -c < "$MEMORY_FILE" 2>/dev/null | tr -d ' ')
  if [[ "$CUR_BYTES" =~ ^[0-9]+$ ]] && (( CUR_BYTES > DAILY_MEMORY_CAP_BYTES )); then
    ARCHIVE_DIR="$AGENT_DIR/memory/archive"
    ARCHIVE_FILE="$ARCHIVE_DIR/$TODAY-rotated-$TIMESTAMP.md"
    if mkdir -p "$ARCHIVE_DIR" 2>/dev/null && cp "$MEMORY_FILE" "$ARCHIVE_FILE" 2>/dev/null; then
      {
        echo "# Daily Memory — $TODAY (auto-rotated)"
        echo ""
        echo "> Auto-rotated $TIMESTAMP by snapshot-agent.sh: file was ${CUR_BYTES}B, over the"
        echo "> ${DAILY_MEMORY_CAP_BYTES}B cap. Full history preserved at"
        echo "> memory/archive/$(basename "$ARCHIVE_FILE"). Recent tail retained below for continuity."
        echo ""
        echo "---"
        echo ""
        tail -n "$DAILY_MEMORY_KEEP_TAIL_LINES" "$ARCHIVE_FILE" 2>/dev/null
      } > "$MEMORY_FILE" 2>/dev/null
    fi
  fi
fi

{
  echo ""
  echo "## AUTO-SNAPSHOT - $TIMESTAMP ($AGENT)"
  echo ""
  echo "Reason: $REASON"
  echo ""
  echo "The daemon took an automatic snapshot and (likely) force-restarted $AGENT."
  echo "Post-restart $AGENT should:"
  echo "- Re-read MEMORY.md, USER.md, today's daily memory file (this one), GOALS.md"
  echo "- Check inbox: cortextos bus check-inbox"
  echo "- Read active tasks: cortextos bus list-tasks --agent $AGENT --status in_progress"
  echo ""
} >> "$MEMORY_FILE" 2>/dev/null

# 2. Log auto_snapshot_taken episode to Neon (best-effort, swallow errors).
if [[ -f "$SECRETS_FILE" ]] && [[ -x "$LOG_EPISODE" ]]; then
  # shellcheck disable=SC1090
  set -o allexport && source "$SECRETS_FILE" 2>/dev/null && set +o allexport
  # Escape double-quotes in REASON for JSON payload.
  REASON_JSON="${REASON//\"/\\\"}"
  bash "$LOG_EPISODE" "$AGENT" guardrail_triggered medium \
    "Auto-snapshot taken at $TIMESTAMP ($AGENT): $REASON" \
    "{\"hook\":\"auto_snapshot\",\"snapshot_at\":\"$TIMESTAMP\",\"memory_file\":\"$MEMORY_FILE\",\"agent\":\"$AGENT\",\"reason\":\"$REASON_JSON\",\"silent\":$SILENT}" \
    >/dev/null 2>&1 || true
fi

# 3. Telegram notification — skipped when --silent.
# Reads BOT_TOKEN and CHAT_ID from the agent's .env. Secrets.env already sourced above.
if [[ "$SILENT" -eq 0 ]]; then
  AGENT_ENV_FILE="$AGENT_DIR/.env"
  if [[ -f "$AGENT_ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -o allexport && source "$AGENT_ENV_FILE" 2>/dev/null && set +o allexport
  fi
  if [[ -n "${BOT_TOKEN:-}" ]] && [[ -n "${CHAT_ID:-}" ]]; then
    curl -s --max-time 4 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"${CHAT_ID}\",\"text\":\"[${AGENT}] Snapshot taken (${REASON}). Memory saved to memory/${TODAY}.md.\"}" \
      >/dev/null 2>&1 || true
  fi
fi

exit 0
