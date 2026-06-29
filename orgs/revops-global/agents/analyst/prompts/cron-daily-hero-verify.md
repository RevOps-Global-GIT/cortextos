# Daily Hero Watchdog — Verify

Cron name: `daily-hero-verify`  
Schedule: `3 8 * * *` America/Los_Angeles  
Purpose: Confirm the OB1 daily hero is live by 8 AM PT. Alert orchestrator if it is not.

First, record the cron fire:

```bash
cortextos bus update-cron-fire daily-hero-verify --interval "3 8 * * *"
```

## Step 1 — Check live latest.json

```bash
TODAY=$(date +%Y-%m-%d)
LIVE_DATE=$(curl -sf https://ob1.revopsglobal.com/vignettes/latest.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('date',''))" 2>/dev/null || echo "unreachable")
echo "Live date: $LIVE_DATE | Expected: $TODAY"
```

**If LIVE_DATE == $TODAY**: hero date is confirmed. Proceed to Step 2 (quality assertions) before logging success.

**If LIVE_DATE != $TODAY**: skip to Step 3.

## Step 2 — Quality assertions: canonical-ref + mobile safe-area

Run the two hard-gate assertions that catch character identity drift and mobile crop regressions:

```bash
cd /home/cortextos/cortextos
ASSERT_EXIT=0
npx tsx scripts/ob1-hero-assertions.ts 2>&1 | tee /tmp/ob1-hero-assertions-${TODAY}.log
ASSERT_EXIT=${PIPESTATUS[0]}
echo "Assertion exit code: $ASSERT_EXIT"
```

**If ASSERT_EXIT == 0** (all assertions pass): hero is fully verified. Log success:

```bash
cortextos bus log-event action daily_hero_status info --meta '{"status":"verified_live","assertions":"pass","date":"'"$TODAY"'"}'
```

Done — no alert needed.

**If ASSERT_EXIT != 0** (one or more assertions failed): extract the failures and alert orchestrator:

```bash
# Extract FAIL lines from the log
FAILURES=$(grep "✗\|FAIL" /tmp/ob1-hero-assertions-${TODAY}.log | head -10)
cortextos bus send-message orchestrator urgent "DAILY HERO QUALITY GATE FAILED on ${TODAY}: ${FAILURES} — Hero date is live but assertions failed. Canonical refs may be missing (character identity drift risk) or mobile safe-area CSS regressed (object-fit:cover crop). Review /tmp/ob1-hero-assertions-${TODAY}.log for detail."
cortextos bus log-event action daily_hero_status error --meta '{"status":"assertions_failed","date":"'"$TODAY"'","failures":"'"$(echo $FAILURES | head -c 200)"'"}'
cortextos bus create-task "Daily hero assertions failed — ${TODAY}" \
  --desc "ob1-hero-assertions.ts exited non-zero at 8 AM PT. Check /tmp/ob1-hero-assertions-${TODAY}.log. Likely causes: (1) canonical ref image 404 on CDN, or (2) mobile safe-area CSS regression (object-fit:cover)." \
  --priority high \
  --success-criteria "npx tsx scripts/ob1-hero-assertions.ts exits 0" \
  --out-of-scope "Regenerating the hero — assertions check the deployed hero, not generation" \
  --goal-ancestry "OB1 daily content reliability"
```

## Step 3 — Hero stale: log FYI only, NO fleet alert

**COWORK-OWNED SURFACE (Greg directive 2026-06-22, updated 2026-06-26):**
Hero/vignette generation and publish is owned exclusively by Claude Cowork (Greg's Mac Claude.app).
The fleet is OFF this surface. mac-codex, Flow, and ob1-app Vercel for hero are NOT fleet concerns.

If LIVE_DATE != $TODAY, the last-good hero holds automatically (Vercel graceful degradation). This is
expected behavior, NOT a fleet incident. Do NOT alert orchestrator as urgent. Do NOT create a task.
Do NOT reference mac-codex, Flow, or Vercel pipeline as fleet investigation targets.

Log FYI only:

```bash
cortextos bus log-event action daily_hero_status info --meta '{"status":"stale_cowork_surface","live_date":"'"$LIVE_DATE"'","expected":"'"$TODAY"'","note":"Cowork-owned — graceful degradation, no fleet action"}'
```

Orchestrator will surface to Greg at evening review if he wants to trigger a regen via Cowork.

## Hard constraints

- NEVER invoke `scripts/generate-daily-vignette.mjs` (Nano-Banana / VM generator).
- NEVER alert orchestrator urgent for a stale hero — Cowork owns this surface.
- NEVER create a fleet task for hero missing — not a fleet incident.
- Do NOT silently skip — always log either success (Step 2) or the FYI (Step 3).
- The last-good hero stays live automatically (Vercel serves last deployed) — do not blank the page.
