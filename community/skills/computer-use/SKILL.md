# Computer-Use Skill

Browser automation and GUI interaction routing for cortextOS agents.

---

## Decision Matrix

Before dispatching ANY browser/click/screenshot/scrape/form/login task, run through this tree top-to-bottom and stop at the first match.

```
Is this a public web app (no session state needed)?
└─ YES → Playwright on cortextos VM (headless)
         scripts/hub-qa-playwright.ts for hub.revopsglobal.com
         `--headless=new --user-data-dir=/tmp/fresh-profile`
         NEVER route Playwright at Greg's Mac Chrome profile via SSH

Does it need Greg's Mac Chrome session (cookies, logged-in profile)?
└─ YES → Mac SSH → codex-dispatch.sh (Codex CU)
         Only for: Mac-specific apps (BotFather, Finder, Safari),
         or Greg's saved auth state that can't be replicated

Everything else (vendor dashboards, OAuth flows, UI validation, screenshots)
└─ DEFAULT → Orgo VM (Codex-ComputerUse VM: 3ec3d7f3)
             `cortextos bus computer-use ...`

Orgo VM unreachable / hard blocker?
└─ FALLBACK → Mac SSH → Codex CU (codex-dispatch.sh)
              Document the gap before falling back
```

**Priority order** (Greg directive 2026-05-18):
1. Orgo Codex-ComputerUse VM — zero Mac impact, fully cloud
2. Mac SSH → Codex CU — only for Mac-app or saved-session carve-outs
3. Claude CU — available but historically lower success rate
4. Playwright (headless Linux only) — public apps, no session state

---

## Orgo VM Fleet

Base URL: `https://www.orgo.ai/api`
Auth: `Authorization: Bearer $ORGO_API_KEY`
Workspace: `4a86b7a4-14be-4248-aa54-71a103647814`

| VM ID | Name | Purpose |
|---|---|---|
| `3ec3d7f3` | Codex-ComputerUse | **Default CU target** — GitHub, Vercel, Supabase, general UI |
| `63845bdb` | Hub-QA | hub.revopsglobal.com QA flows |
| `cf79bc43` | LinkedIn-Session | LinkedIn auth state (li_at cookie) |
| `cf8cb3d9` | Telegram-Web | Telegram Web automation |
| `289e5608` | Wiki-Ingestion-Worker | wiki/doc ingestion |
| `23e7d600` | Complimentary1 | Overflow |
| `4229f370` | Complimentary2 | Overflow |
| `ec0c11f1` | Complimentary3 | Overflow |

Direct VM control uses **vnc_password** as Bearer token (NOT ORGO_API_KEY):
```
GET /computers/{id}  →  returns url + vnc_password
curl -H "Authorization: Bearer <vnc_password>" <url>/screenshot
curl -H "Authorization: Bearer <vnc_password>" <url>/bash -d '{"command":"..."}'
```

---

## Gotchas

### 1. Two Permission Layers (Mac CU only)

Mac Codex CU requires BOTH to be green:

**Layer 1 — macOS TCC** (System Settings → Privacy & Security)
- Accessibility, Screen Recording, Automation
- Greg grants via UI; generally stays green

**Layer 2 — Codex MCP Plugin Elicitation**
- Per-app runtime approvals stored in `~/.codex/.codex-global-state.json`
- Headless SSH auto-denies (no UI to click Allow)
- Fix: `--dangerously-bypass-approvals-and-sandbox` in codex-dispatch.sh (shipped PR team-brain#79)
- Verify: `cortextos bus computer-use --timeout 60 "Screenshot frontmost Chrome window, report the URL"` → must return a URL, not "approval denied"

**Layer 3 — Chrome CDP Consent** (NOT bypassed by Fix B)
- Chrome shows "Allow remote debugging?" when CU attaches via CDP
- Bypass: Use Playwright on Linux for public apps (avoids Mac + Chrome entirely)

### 2. Chromium Bot Detection / Turnstile

Orgo VM Chromium may be fingerprinted as a bot on hardened sites (Cloudflare Turnstile, hCaptcha, LinkedIn anti-scrape).

Mitigations (in order):
1. Use the LinkedIn-Session VM (`cf79bc43`) for LinkedIn — it has established cookies and warm session state
2. Inject session cookies via CDP (see Session Cookie Injection below) before navigating
3. Slow down interactions — add human-like delays between actions
4. If Turnstile fires, dispatch to Mac SSH Codex CU path (uses Greg's real Chrome profile which passes bot checks)
5. For persistent Turnstile blocks: route to Mac SSH → codex-dispatch.sh with Greg's logged-in Chrome

### 3. Process Ephemerality on Orgo VMs

Processes launched via `cortextos bus computer-use` exec() are **ephemeral** — they die on VM reboot.

- Do NOT rely on one-shot exec() surviving across days
- Long-running workloads must be wrapped as:
  - `systemd user service` (`~/.config/systemd/user/`, `systemctl --user enable`)
  - Persistent cron entry (`@reboot /path/to/runner`)
- When auditing a "claimed workload" with no artifacts, verify the process is actually supervised

### 4. Session Cookie Injection (CDP)

To restore session state on Orgo VMs, use CDP — NOT SQLite DB writes (Chrome ignores those).

```python
# Connect to Chrome DevTools on port 9222
# Use Network.setCookie for each cookie
import websocket, json

ws = websocket.create_connection("ws://localhost:9222/json")
pages = json.loads(ws.recv())
ws.close()

ws = websocket.create_connection(pages[0]['webSocketDebuggerUrl'])
for cookie in cookies:
    ws.send(json.dumps({
        "id": 1,
        "method": "Network.setCookie",
        "params": cookie
    }))
    ws.recv()
ws.close()
```

Validated 2026-05-14: CDP injection of 27 cookies (incl. li_at) produced working LinkedIn feed. SQLite write alone failed silently.

### 5. maxBuffer / ENOBUFS Crash

`src/bus/computer-use.ts` default `maxBuffer` is 1 MB — large CU outputs (screenshots encoded as base64) cause cryptic ENOBUFS crash.

Fix (if hitting this): set `maxBuffer: 10 * 1024 * 1024` on both `execFileSync` calls in `src/bus/computer-use.ts` (lines ~111, ~163). Track in reliability audit: `dev/output/2026-05-09-computer-use-reliability-audit.md`.

### 6. SSH Keepalive / Timeout Orphan (Mac CU)

Remote processes are orphaned when SSH times out — `codex-dispatch.sh` and `codex exec` keep running on Mac after SIGTERM.

Mitigations:
- Add `ServerAliveInterval=30 ServerAliveCountMax=2` to SSH options (cuts worst-case hang from 360s → ~70s)
- Generate session IDs per dispatch; issue SSH cleanup command after timeout catches

### 7. Stopped Orgo Metal VMs Are Unrecoverable

`restart_computer` API is broken for stopped metal VMs. Only path: `DELETE + CREATE_COMPUTER` (destructive — auth state lost).

**Never stop Orgo VMs.** Idle VM = load-up problem. Delete-recreate costs full auth rebuild.

---

## Fallback Chain (Full)

```
TASK: browser/UI/screenshot/click/scrape/login

Step 1: Is it a public web app with no session state?
  YES → scripts/hub-qa-playwright.ts (headless Linux)
  NO  → Step 2

Step 2: Does it need Greg's Mac Chrome session state?
  YES → Mac SSH → codex-dispatch.sh --dangerously-bypass-approvals-and-sandbox
  NO  → Step 3

Step 3: Route to Orgo Codex-ComputerUse VM (3ec3d7f3)
  WORKS → done
  CAPTCHA/Turnstile fires → Step 4
  VM down/unreachable → Step 5

Step 4: Anti-bot hit
  Is it LinkedIn? → Switch to LinkedIn-Session VM (cf79bc43) with cookie injection
  Is it Cloudflare Turnstile? → Mac SSH → Codex CU (Greg's Chrome passes bot checks)
  Otherwise → add human-like delays, retry on same VM; if 2nd failure → Mac SSH

Step 5: Orgo VM hard failure
  Document the specific failure (screenshot or error text)
  Fallback: Mac SSH → codex-dispatch.sh
  If Mac SSH also fails → surface blocker to orchestrator with failure artifact
```

---

## Pre-Dispatch Checklist

Before sending ANY message containing these phrases, convert to a CU dispatch instead:

> "can you open X and tell me what you see" / "ready for you to validate" / "let me know if it looks right" / "eyeball it when you have 2 min" / "send me a screenshot" / "can you screenshot" / "what do you see" / "show me the state"

**Convert to**: `cortextos bus send-message codex high "[COMPUTER-USE TASK] ..."` with explicit steps.

This is a high-cost feedback pattern — every recurrence erodes trust. Dispatch instead of asking Greg.

---

## Dispatch Templates

### Orgo VM (default)
```bash
cortextos bus computer-use "Navigate to https://hub.revopsglobal.com/app/fleet/tasks and take a screenshot. Report what you see in the task list."
```

### Mac SSH Codex CU (carve-out)
```bash
cortextos bus send-message codex high "[COMPUTER-USE TASK] Open hub.revopsglobal.com/app/fleet/tasks in Chrome. Take a screenshot. Return the screenshot path. Steps: 1) Navigate to URL. 2) Wait for page load. 3) Screenshot." <msg_id>
```

### Playwright (public app, headless Linux)
```bash
npx ts-node scripts/hub-qa-playwright.ts
# or custom:
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://hub.revopsglobal.com/app/fleet/tasks');
  await page.screenshot({ path: 'output/screenshot.png' });
  await browser.close();
})();
"
```

---

## References

- Decision history: `feedback_orgo_vm_cu_replaces_mac_default.md`, `feedback_ui_runtime_priority.md`
- Two-layer permission model: `feedback_computer_use_two_perm_layers.md`
- Orgo API + fleet: `reference_orgo_api.md`
- CDP cookie injection: `reference_orgo_vm_cdp_injection.md`
- Process ephemerality: `reference_orgo_exec_ephemerality.md`
- Dispatch anti-pattern: `feedback_codex_computer_use.md`
- Reliability audit: `dev/output/2026-05-09-computer-use-reliability-audit.md`
- Speed alternatives evaluation: `analyst/output/2026-05-10-computer-use-alternatives.md`

---

## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
