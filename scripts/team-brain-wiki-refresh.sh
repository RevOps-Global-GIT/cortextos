#!/usr/bin/env bash
set -euo pipefail

# Mac-independent team-brain wiki refresh runner for cron on the cortextOS VM.
# Usage:
#   team-brain-wiki-refresh.sh fathom
#   team-brain-wiki-refresh.sh wiki

MODE="${1:-}"
: "${HOME:?HOME must be set}"
CORTEXTOS_HOME="${CORTEXTOS_HOME:-$HOME}"
REPO_DIR="${TEAM_BRAIN_REPO:-$CORTEXTOS_HOME/work/team-brain}"
LOG_DIR="${TEAM_BRAIN_LOG_DIR:-$REPO_DIR/logs}"
BRANCH="${TEAM_BRAIN_BRANCH:-main}"
SINCE_DAYS="${TEAM_BRAIN_WIKI_SINCE_DAYS:-7}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"

PATH="/usr/local/bin:/usr/bin:/bin:$CORTEXTOS_HOME/.local/bin:$PATH"

if [[ "$MODE" != "fathom" && "$MODE" != "wiki" ]]; then
  echo "usage: $0 {fathom|wiki}" >&2
  exit 64
fi

mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/team-brain-wiki-refresh-$MODE.log" 2>&1

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) team-brain wiki refresh ($MODE) start ==="

log_bus_event() {
  local event="$1"
  local severity="$2"
  local reason="$3"
  if command -v cortextos >/dev/null 2>&1; then
    cortextos bus log-event action "$event" "$severity" --meta \
      '{"script":"team-brain-wiki-refresh","mode":"'"$MODE"'","repo":"'"$REPO_DIR"'","branch":"'"$BRANCH"'","reason":"'"$reason"'"}' \
      >/dev/null 2>&1 || true
  fi
}

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "ERROR: $REPO_DIR is not a git checkout" >&2
  log_bus_event team_brain_wiki_refresh_error error "repo_not_a_git_checkout"
  cortextos bus send-message orchestrator normal "team-brain-wiki-refresh ($MODE) FAILED: $REPO_DIR is not a git repo — manual intervention required" >/dev/null 2>&1 || true
  exit 1
fi

cd "$REPO_DIR"

export SUPABASE_RGOS_SERVICE_KEY="${SUPABASE_RGOS_SERVICE_KEY:-$(python3 - <<'PY' 2>/dev/null || true
import json, os
path = os.path.expanduser("~/.claude/settings.json")
try:
    print(json.load(open(path)).get("env", {}).get("SUPABASE_RGOS_SERVICE_KEY", ""))
except Exception:
    print("")
PY
)}"

if [[ -z "$SUPABASE_RGOS_SERVICE_KEY" ]]; then
  _CORTEXTOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  _SECRETS_ENV="$_CORTEXTOS_DIR/orgs/revops-global/secrets.env"
  if [[ -f "$_SECRETS_ENV" ]]; then
    set +u
    # shellcheck source=/dev/null
    source "$_SECRETS_ENV"
    set -u
    export SUPABASE_RGOS_SERVICE_KEY="${SUPABASE_RGOS_SERVICE_KEY:-}"
  fi
  unset _CORTEXTOS_DIR _SECRETS_ENV
fi

if [[ "$MODE" == "wiki" && -z "$SUPABASE_RGOS_SERVICE_KEY" ]]; then
  echo "ERROR: SUPABASE_RGOS_SERVICE_KEY not found in env, ~/.claude/settings.json, or orgs/revops-global/secrets.env" >&2
  log_bus_event team_brain_wiki_refresh_error error "missing_supabase_key"
  cortextos bus send-message orchestrator normal "team-brain-wiki-refresh (wiki) FAILED: SUPABASE_RGOS_SERVICE_KEY missing — check env, ~/.claude/settings.json, or orgs/revops-global/secrets.env" >/dev/null 2>&1 || true
  exit 1
fi

if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  git fetch origin "$BRANCH"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  STASH_NAME="team-brain-wiki-refresh-autostash-$MODE-$RUN_ID"
  echo "WARNING: dirty worktree detected; stashing as $STASH_NAME"
  git stash push -u -m "$STASH_NAME"
  log_bus_event team_brain_wiki_refresh_anomaly warning "dirty_worktree_stashed:$STASH_NAME"
fi

git fetch origin "$BRANCH"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  LOCAL_HEAD="$(git rev-parse "$BRANCH")"
  REMOTE_HEAD="$(git rev-parse "origin/$BRANCH")"
  if [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
    BACKUP_BRANCH="autobackup/team-brain-wiki-refresh-$MODE-$BRANCH-$RUN_ID"
    echo "WARNING: local $BRANCH diverges from origin/$BRANCH; preserving local head at $BACKUP_BRANCH"
    git branch "$BACKUP_BRANCH" "$BRANCH"
    log_bus_event team_brain_wiki_refresh_anomaly warning "local_branch_reset:backup=$BACKUP_BRANCH"
  fi
  git checkout "$BRANCH"
else
  git checkout -b "$BRANCH" "origin/$BRANCH"
fi

git reset --hard "origin/$BRANCH"
git pull --ff-only origin "$BRANCH"

case "$MODE" in
  fathom)
    node scripts/fathom-ingest.js
    ;;
  wiki)
    SINCE="$(python3 - "$SINCE_DAYS" <<'PY'
from datetime import datetime, timedelta, timezone
import sys
days = int(sys.argv[1])
print((datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d"))
PY
)"
    python3 scripts/wiki-ingest-meetings.py --since "$SINCE"
    python3 scripts/wiki-sync.py --changed
    ;;
esac

git add wiki
if [[ -d wiki/sources/meetings ]]; then
  find wiki/sources/meetings -maxdepth 1 -type f -name '*.md' -print0 | xargs -0r git add -f
fi

if ! git diff --cached --quiet -- wiki; then
  git commit -m "chore(wiki): refresh meeting sources"
  git push origin "$BRANCH"
else
  echo "No wiki changes to commit"
fi

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) team-brain wiki refresh ($MODE) finished ==="
