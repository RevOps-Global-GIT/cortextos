Run weekly signal diff using a dedicated temporary team-brain worktree off origin/main. Do NOT use /home/cortextos/work/team-brain and do NOT run the stale scripts/loops/weekly-signal-diff.sh path.

Execute this bash block:

```bash
set -euo pipefail
TODAY=$(date -u +%Y-%m-%d)
BASE="/home/cortextos/.cortexos/wiki-publisher/team-brain"
WT="/tmp/team-brain-weekly-signal-diff-${TODAY}-$$"
OUT="wiki/sources/signals/${TODAY}-weekly-diff.md"
LOG="/tmp/weekly-signal-diff-${TODAY}.log"
cleanup() { git -C "$BASE" worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

git -C "$BASE" fetch origin main
git -C "$BASE" worktree add "$WT" origin/main
cd "$WT"
mkdir -p logs wiki/sources/signals
CLAUDE_BIN="$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")"
"$CLAUDE_BIN" --dangerously-skip-permissions --model claude-sonnet-4-6 \
  -p "Run the /weekly-signal-diff skill against my watchlist. Write the full output to ${OUT} with proper wiki frontmatter (type: source, slug: sources/signals/${TODAY}-weekly-diff). Add a one-paragraph summary to the top suitable for the daily digest's Market Signals section. Do NOT commit or push; this wrapper prompt commits and pushes the generated wiki output. Run autonomously." \
  > "$LOG" 2>&1

if [ ! -f "$OUT" ]; then
  tail -n 20 "$LOG" >&2 || true
  cortextos bus send-message orchestrator normal "weekly-signal-diff failed: ${OUT} was not produced; see ${LOG}" || true
  exit 1
fi
printf -- '- %s: weekly signal diff ([[sources/signals/%s-weekly-diff]])\n' "$TODAY" "$TODAY" >> wiki/log.md
git add "$OUT" wiki/log.md
if git diff --cached --quiet; then
  echo "weekly-signal-diff: no wiki changes to push"
else
  git -c user.email="greg@revopsglobal.com" -c user.name="Greg Harned" commit -m "feat(wiki): weekly signal diff ${TODAY}"
  git fetch origin main
  git rebase origin/main
  git push origin HEAD:main
fi
```

If the block exits non-zero and did not already notify orchestrator, send a concise blocker to orchestrator with the last error line.
