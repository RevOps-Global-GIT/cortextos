# Computer-Use Skill

Browser automation and GUI interaction routing for cortextOS agents.

> Orgo/Codex-CU was removed 2026-06. agent-browser is now the primary browser
> runtime; Mac SSH Codex is the fallback for Mac-only state. Do not route to Orgo.

---

## Decision Matrix

Before dispatching ANY browser/click/screenshot/scrape/form/login task, run through this tree top-to-bottom and stop at the first match.

```
Is this a stateless, scripted check (deploy verify, mobile QA, copy/color audit, multi-URL sweep)?
└─ YES → dev-browser --headless

Is this authenticated QA of hub.revopsglobal.com specifically?
└─ YES → scripts/hub-qa-playwright.ts (headless Chromium + minted Supabase session)

Does it need a logged-in or exploratory browser session (vendor dashboards,
OAuth flows, UI validation, screenshots, click-throughs)?
└─ YES → agent-browser (primary; reuses a persistent profile)

Does it need Greg's Mac app or saved desktop session (a native macOS app like
BotFather/Finder/Safari, or auth state that cannot be replicated)?
└─ YES → Mac SSH → codex-dispatch.sh (Codex CU)
         `cortextos bus computer-use --ssh-host gregs-mac "..."`
```

**Priority order:**
1. agent-browser — primary browser runtime for logged-in/exploratory work.
2. dev-browser --headless — stateless scripted tasks.
3. scripts/hub-qa-playwright.ts — authenticated hub.revopsglobal.com QA harness.
4. Mac SSH Codex CU — only for Mac-app or saved-session carve-outs.

---

## Gotchas

### 1. Two Permission Layers (Mac CU only)

Mac Codex CU (the `--ssh-host gregs-mac` fallback) requires BOTH to be green:

**Layer 1: macOS TCC** (System Settings, Privacy & Security)
- Accessibility, Screen Recording, Automation.
- Greg grants via UI; generally stays green.

**Layer 2: Codex MCP Plugin Elicitation**
- Per-app runtime approvals stored in `~/.codex/.codex-global-state.json`.
- Headless SSH auto-denies (no UI to click Allow).
- Fix: `--dangerously-bypass-approvals-and-sandbox` in codex-dispatch.sh (shipped PR team-brain#79).
- Verify: `cortextos bus computer-use --ssh-host gregs-mac --timeout 60 "Screenshot frontmost Chrome window, report the URL"` returns a URL, not "approval denied".

**Layer 3: Chrome CDP Consent** (not bypassed by Layer 2 fix)
- Chrome shows "Allow remote debugging?" when CU attaches via CDP.
- Avoid by using dev-browser/agent-browser for public or session work instead of the Mac Chrome path.

### 2. Bot Detection / Turnstile on hardened sites

Headless or fresh-profile browsers can be fingerprinted as bots on hardened sites (Cloudflare Turnstile, hCaptcha, LinkedIn anti-scrape).

Mitigations (in order):
1. Use agent-browser with its persistent, warmed profile (logged-in session state passes most checks) rather than a fresh headless profile.
2. Slow down interactions: add human-like delays between actions.
3. If a hard anti-bot wall fires (persistent Turnstile), fall back to Mac SSH Codex CU, which drives Greg's real Chrome profile and passes bot checks.

### 3. maxBuffer / ENOBUFS Crash

`src/bus/computer-use.ts` sets `maxBuffer: 10 * 1024 * 1024` on its `execFileSync` calls; large CU outputs (base64-encoded screenshots) overflow a 1 MB default and cause a cryptic ENOBUFS crash. Keep the 10 MB buffer if you touch that file. Background: `dev/output/2026-05-09-computer-use-reliability-audit.md`.

### 4. SSH Keepalive / Timeout Orphan (Mac CU)

Remote processes are orphaned when SSH times out: `codex-dispatch.sh` and `codex exec` keep running on the Mac after SIGTERM.

Mitigations (already in `computer-use.ts`):
- `ServerAliveInterval=30 ServerAliveCountMax=2` on the SSH options (cuts worst-case hang from ~360s to ~70s).
- On an ETIMEDOUT catch, a best-effort SSH cleanup command kills orphaned `codex-dispatch.sh` / `codex exec` on the host.

---

## Fallback Chain (Full)

```
TASK: browser/UI/screenshot/click/scrape/login

Step 1: Stateless scripted check (no session state)?
  YES → dev-browser --headless
  NO  → Step 2

Step 2: Authenticated hub.revopsglobal.com QA?
  YES → scripts/hub-qa-playwright.ts (minted Supabase session)
  NO  → Step 3

Step 3: Logged-in / exploratory browser session?
  YES → agent-browser (primary)
  WORKS → done
  Hard anti-bot wall (persistent Turnstile) → Step 4
  Needs Mac-only app/session state → Step 4

Step 4: Mac SSH → codex-dispatch.sh --dangerously-bypass-approvals-and-sandbox
  (cortextos bus computer-use --ssh-host gregs-mac "...")
  If Mac SSH also fails → surface blocker to orchestrator with a failure artifact
```

---

## Pre-Dispatch Checklist

Before sending ANY message containing these phrases, convert it to a browser dispatch instead of asking Greg:

> "can you open X and tell me what you see" / "ready for you to validate" / "let me know if it looks right" / "eyeball it when you have 2 min" / "send me a screenshot" / "can you screenshot" / "what do you see" / "show me the state"

**Convert to** an agent-browser run (or a `[COMPUTER-USE TASK]` dispatch to codex with explicit steps). This is a high-cost feedback pattern; every recurrence erodes trust. Drive the browser instead of asking Greg.

---

## Dispatch Templates

### agent-browser (default)
```bash
agent-browser open https://hub.revopsglobal.com/app/fleet/tasks
agent-browser screenshot /tmp/fleet-tasks.png
agent-browser get text "h1"
```

### dev-browser (stateless scripted)
```bash
dev-browser --headless open https://hub.revopsglobal.com/app/fleet/tasks
dev-browser --headless screenshot /tmp/fleet-tasks.png
```

### Mac SSH Codex CU (Mac-only carve-out)
```bash
cortextos bus computer-use --ssh-host gregs-mac "Open hub.revopsglobal.com/app/fleet/tasks in Chrome. Wait for load. Take a screenshot and return its path."
```

### Authenticated hub QA harness
```bash
npx tsx scripts/hub-qa-playwright.ts --page /app/fleet/tasks --no-send
```

---

## References

- Two-layer permission model: `feedback_computer_use_two_perm_layers.md`
- Dispatch anti-pattern: `feedback_codex_computer_use.md`
- Reliability audit: `dev/output/2026-05-09-computer-use-reliability-audit.md`
- Browser ladder (agent-browser vs dev-browser): `~/.claude/CLAUDE.md` and `~/work/CLAUDE.md`

---

## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
