#!/usr/bin/env bash
set -euo pipefail

# Mac-independent team-brain wiki refresh runner for cron on the cortextOS VM.
# Usage:
#   team-brain-wiki-refresh.sh fathom
#   team-brain-wiki-refresh.sh wiki

MODE="${1:-}"
REPO_DIR="${TEAM_BRAIN_REPO:-/home/cortextos/work/team-brain}"
LOG_DIR="${TEAM_BRAIN_LOG_DIR:-$REPO_DIR/logs}"
BRANCH="${TEAM_BRAIN_BRANCH:-main}"
SINCE_DAYS="${TEAM_BRAIN_WIKI_SINCE_DAYS:-7}"

PATH="/usr/local/bin:/usr/bin:/bin:/home/cortextos/.local/bin:$PATH"

if [[ "$MODE" != "fathom" && "$MODE" != "wiki" ]]; then
  echo "usage: $0 {fathom|wiki}" >&2
  exit 64
fi

mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/team-brain-wiki-refresh-$MODE.log" 2>&1

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) team-brain wiki refresh ($MODE) start ==="

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "ERROR: $REPO_DIR is not a git checkout" >&2
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

if [[ "$MODE" == "wiki" && -z "$SUPABASE_RGOS_SERVICE_KEY" ]]; then
  echo "ERROR: SUPABASE_RGOS_SERVICE_KEY not found in env or ~/.claude/settings.json" >&2
  exit 1
fi

git fetch origin "$BRANCH"
git checkout "$BRANCH"
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
