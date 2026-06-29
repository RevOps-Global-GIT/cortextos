Run daily Slack -> wiki sync using a dedicated temporary team-brain worktree off origin/main. Do NOT write through /home/cortextos/work/team-brain or leave files in the publisher clone.

Execute this bash block:

```bash
set -euo pipefail
TODAY=$(date -u +%Y-%m-%d)
BASE="/home/cortextos/.cortexos/wiki-publisher/team-brain"
WT="/tmp/team-brain-slack-to-wiki-${TODAY}-$$"
LOG="/tmp/slack-wiki-sync.log"
cleanup() { git -C "$BASE" worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

git -C "$BASE" fetch origin main
git -C "$BASE" worktree add "$WT" origin/main
cd /home/cortextos/cortextos
set -a
source orgs/revops-global/secrets.env
set +a
SUPABASE_SERVICE_KEY="$RGOS_SUPABASE_SERVICE_KEY" /usr/bin/python3 "$WT/scripts/slack_to_wiki.py" > "$LOG" 2>&1

cd "$WT"
git add wiki/sources/slack 2>/dev/null || true
if git diff --cached --quiet; then
  echo "slack-to-wiki: no wiki changes to push"
else
  git -c user.email="greg@revopsglobal.com" -c user.name="Greg Harned" commit -m "docs(wiki): Slack sync ${TODAY}"
  git fetch origin main
  git rebase origin/main
  git push origin HEAD:main
fi
```

If the block exits non-zero, read the last error line from /tmp/slack-wiki-sync.log if present and send: cortextos bus send-message orchestrator normal "slack-to-wiki failed: <last error line>".
