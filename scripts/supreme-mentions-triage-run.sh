#!/usr/bin/env bash
# supreme-mentions-triage-run.sh
#
# Direct-API replacement for the old Orgo CU capture path.
# Runs the Slack scanner (no browser/Orgo) to refresh mentions data,
# then feeds the digest into the ingest script with --allow-fallback.
#
# Interval: 2h (same as the removed Orgo-based cron).
# Fail-fast: exits 1 on missing secrets; warns if stale ORGO_API_KEY is set.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORG_ROOT="$REPO_ROOT/orgs/revops-global"
ANALYST_SCRIPTS="$ORG_ROOT/agents/analyst/scripts"
ANALYST_OUTPUT="$ORG_ROOT/agents/analyst/output"
SECRETS="$ORG_ROOT/secrets.env"

# Fail-fast: Orgo is decommissioned; presence of ORGO_API_KEY means stale config
if [[ -n "${ORGO_API_KEY:-}" ]]; then
  echo "[supreme-mentions] WARN: ORGO_API_KEY is set but Orgo is decommissioned — ignoring" >&2
fi

# Source org secrets (SUPABASE_RGOS_URL, SUPABASE_RGOS_SERVICE_KEY, SLACK_CLIENT_ID, etc.)
if [[ ! -f "$SECRETS" ]]; then
  echo "[supreme-mentions] ERROR: secrets.env not found at $SECRETS" >&2
  exit 1
fi
set -a
# shellcheck source=/dev/null
source "$SECRETS"
set +a

# Verify required Slack secrets are present
for var in SUPABASE_RGOS_URL SUPABASE_RGOS_SERVICE_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "[supreme-mentions] ERROR: $var not set in secrets.env" >&2
    exit 1
  fi
done

echo "[supreme-mentions] Running Slack scanner (direct API)..."
python3 "$ANALYST_SCRIPTS/supreme-slack-scanner.py" 2>&1 || {
  echo "[supreme-mentions] WARN: scanner exited non-zero — continuing with existing digest" >&2
}

echo "[supreme-mentions] Running ingest with digest fallback..."
python3 "$ANALYST_SCRIPTS/supreme-mentions-triage-ingest.py" \
  --input "$ANALYST_OUTPUT/supreme-outstanding-digest.txt" \
  --allow-fallback \
  --capture-timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  2>&1

echo "[supreme-mentions] Done"
