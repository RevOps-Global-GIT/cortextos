#!/usr/bin/env bash
# run-dogfood-pinned.sh
#
# Runs the hub-qa-playwright harness from a dedicated git worktree that is
# always pinned to fork/main HEAD. Prevents stale-harness false FAILs that
# occur when the shared checkout has a feature branch checked out.
#
# Worktree: /tmp/cortextos-dogfood-main
# Remote:   fork (https://github.com/RevOps-Global-GIT/cortextos)
#
# Usage:
#   bash scripts/run-dogfood-pinned.sh --page /app/fleet/tasks [--no-send] [--dogfood] [extra args...]
#
# All arguments are forwarded to hub-qa-playwright.ts.

set -euo pipefail

# SCRIPT_REPO is the repo that owns this wrapper script (used for git operations
# and locating secrets). WORKTREE is the pinned read-only execution context.
SCRIPT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE="/tmp/cortextos-dogfood-main"
REMOTE="fork"
BRANCH="main"

# ── 1. Ensure the pinned worktree exists ──────────────────────────────────────
if [[ ! -d "$WORKTREE/.git" ]] && [[ ! -f "$WORKTREE/.git" ]]; then
  echo "[dogfood-pinned] Creating worktree at $WORKTREE"
  git -C "$SCRIPT_REPO" worktree add --detach "$WORKTREE" "remotes/$REMOTE/$BRANCH"
fi

# ── 2. Fetch latest fork/main and hard-reset the worktree ─────────────────────
echo "[dogfood-pinned] Fetching $REMOTE/$BRANCH"
git -C "$SCRIPT_REPO" fetch "$REMOTE" "$BRANCH" --quiet

PINNED_SHA=$(git -C "$SCRIPT_REPO" rev-parse "remotes/$REMOTE/$BRANCH")
echo "[dogfood-pinned] Pinning worktree to $PINNED_SHA"
git -C "$WORKTREE" reset --hard "$PINNED_SHA" --quiet

# ── 3. Install deps if node_modules is absent (first run or evicted) ──────────
if [[ ! -d "$WORKTREE/node_modules" ]]; then
  echo "[dogfood-pinned] Installing dependencies"
  npm --prefix "$WORKTREE" ci --prefer-offline --quiet
fi

# ── 4. Point harness at original repo's secrets (worktree has none) ──────────
# hub-qa-playwright.ts resolves secrets via CTX_SECRETS_ENV (env var) or falls
# back to <SCRIPT_DIR>/../orgs/revops-global/secrets.env. The pinned worktree
# has no secrets, so export CTX_SECRETS_ENV to the real secrets file.
export CTX_SECRETS_ENV="${CTX_SECRETS_ENV:-$SCRIPT_REPO/orgs/revops-global/secrets.env}"

# ── 5. Run harness from pinned worktree ───────────────────────────────────────
echo "[dogfood-pinned] Running harness (SHA: ${PINNED_SHA:0:9})"
cd "$WORKTREE"
exec npx tsx scripts/hub-qa-playwright.ts "$@"
