Run the nightly skill QA audit using a dedicated temporary team-brain worktree off origin/main. Do NOT write through the publisher clone or shared checkout.

Execute this bash block:

```bash
set -euo pipefail
TODAY=$(date -u +%Y-%m-%d)
BASE="/home/cortextos/.cortexos/wiki-publisher/team-brain"
WT="/tmp/team-brain-skill-qa-${TODAY}-$$"
LOG="/tmp/skill-qa-nightly-${TODAY}.log"
cleanup() { git -C "$BASE" worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

git -C "$BASE" fetch origin main
git -C "$BASE" worktree add "$WT" origin/main
SKILL_QA_REPO_ROOT="$WT" python3 /home/cortextos/cortextos/orgs/revops-global/agents/analyst/scripts/skill-qa-nightly.py 2>&1 | tee "$LOG"
```

The script scans all skills in the temporary worktree, writes docs/skill-health-YYYY-MM-DD.md, commits/rebases/pushes the generated report to team-brain origin/main, and posts a snapshot row to shared_snapshots in data Supabase. Review script output. If "ALERT: Critical issues found" appears, send a message to orchestrator: cortextos bus send-message orchestrator normal "skill-qa: critical issues found in todays run — see report". If no critical issues, do nothing further.
