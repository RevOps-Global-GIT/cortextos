#!/usr/bin/env bash
# cleanup-stale-branches.sh — Delete stale remote branches from the RGOS repo.
# Usage: ./cleanup-stale-branches.sh [--repo <path>] [--days <N>] [--dry-run]
#
# Deletes branches whose last commit is older than --days (default: 2) days.
# Protects: main, branches with open PRs.
# Safe to re-run (idempotent — only deletes what still exists).

set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/cortextos/rgos}"
DAYS="${DAYS:-2}"
DRY_RUN=false

for arg in "$@"; do
  case $arg in
    --repo=*) REPO_DIR="${arg#*=}" ;;
    --days=*) DAYS="${arg#*=}" ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

cd "$REPO_DIR"
echo "[branch-cleanup] Repo: $REPO_DIR"
echo "[branch-cleanup] Stale threshold: $DAYS days"
echo "[branch-cleanup] Dry run: $DRY_RUN"

# Fetch latest remote state
git fetch --prune --quiet

CUTOFF=$(date -d "${DAYS} days ago" +%Y-%m-%d)
echo "[branch-cleanup] Cutoff date: $CUTOFF"

# Collect open PR branches (protect them)
OPEN_PR_BRANCHES=$(gh pr list --repo RevOps-Global-GIT/rgos --state open --json headRefName --limit 500 2>/dev/null | jq -r '.[].headRefName' | sort || true)

DELETED=0
PROTECTED=0
SKIPPED=0

while IFS= read -r branch; do
  last=$(git log -1 --format="%ai" "origin/$branch" 2>/dev/null | cut -c1-10)
  if [[ "$last" < "$CUTOFF" ]]; then
    # Check open PRs
    if echo "$OPEN_PR_BRANCHES" | grep -qx "$branch"; then
      echo "[branch-cleanup] PROTECTED (open PR): $branch ($last)"
      ((PROTECTED++)) || true
      continue
    fi
    if $DRY_RUN; then
      echo "[branch-cleanup] DRY-RUN would delete: $branch ($last)"
    else
      git push origin --delete "$branch" --quiet 2>/dev/null && \
        echo "[branch-cleanup] Deleted: $branch ($last)" && ((DELETED++)) || true
    fi
  else
    ((SKIPPED++)) || true
  fi
done < <(git branch -r | grep -v "HEAD\|origin/main" | sed 's/origin\///')

echo ""
echo "[branch-cleanup] Done — deleted: $DELETED, protected: $PROTECTED, kept (recent): $SKIPPED"
REMAINING=$(git branch -r | grep -v "HEAD\|origin/main" | wc -l)
echo "[branch-cleanup] Remaining remote branches: $REMAINING"
