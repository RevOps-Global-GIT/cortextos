# Orgo VM Persistent Auth Profile

This runbook documents the RevOps Global Orgo VM browser auth bundle used by
agents that need production verification without asking Greg to sign in by VNC.

## Canonical Files

- Linux secret bundle:
  `/home/cortextos/cortextos/orgs/revops-global/secrets/orgo-vm-sessions.json.enc`
- Linux metadata:
  `/home/cortextos/cortextos/orgs/revops-global/secrets/orgo-vm-sessions.meta.json`
- Orgo VM copy:
  `/root/.config/cortextos/orgo-vm-auth/orgo-vm-sessions.json.enc`
- Orgo VM metadata:
  `/root/.config/cortextos/orgo-vm-auth/orgo-vm-sessions.meta.json`

Both local files are ignored by git and must be `0600`.

## Current State, 2026-05-24

The bundle is encrypted with `INTERNAL_CRON_SECRET` using the existing
`scrypt` + `aes-256-gcm` envelope shape used by prior cookie exports.

Orca is verified. The working path is the production API:

```bash
curl -X POST https://orca.revopsglobal.com/api/auth/login \
  -H 'Content-Type: application/json' \
  --data '{"pin":"6301","trustedDevice":true}'
```

Persist the returned `orca_session` cookie and the returned session token. The
Orgo smoke result should show `orca_restored: true`, `.voice-shell` present, and
no PIN page.

Hub is not verified from the current bundle. The Orgo smoke result redirects to
`https://hub.revopsglobal.com/auth` and shows the Google sign-in / sign-in-link
screen. A guarded Mac export pass on 2026-05-24 also failed: the accessible
RevOps Chrome profile redirected to `/auth`, active Hub cookies were not present,
and the advertised Chrome CDP endpoint returned unusable 404/empty responses.
The blocker artifact is:
`/home/cortextos/cortextos/orgs/revops-global/agents/codex/output/orgo-vm-persistent-auth-20260524/hub-mac-export-blocker.json`.

Hub requires a fresh authenticated Hub session in an accessible Mac Chrome
profile, a working CDP cookie export from that profile, or a completed Google
2FA/sign-in-link action scoped specifically to Hub.

## Resume Protocol

1. Load org secrets locally:

   ```bash
   set -a
   source /home/cortextos/cortextos/orgs/revops-global/secrets.env
   set +a
   ```

2. Push the encrypted bundle to the Orgo VM:

   ```bash
   node scripts/orgo-vm-auth-smoke.js --push-only
   ```

3. Smoke-test the Orgo VM restore:

   ```bash
   node scripts/orgo-vm-auth-smoke.js
   ```

4. Read the report on the Orgo VM:

   ```text
   /root/.config/cortextos/orgo-vm-auth/restore-smoke-report.json
   ```

5. A successful full restore requires:

   - `orca_restored: true`
   - `hub_restored: true`

If Orgo reports that `INTERNAL_CRON_SECRET` is missing, inject it only for the
restore process or install it into the Orgo runtime environment through the
approved secrets channel. Do not write the raw secret to git or logs.

## Mac Auth Source Rules

Mac Chrome may be used only when a current Orgo-failure artifact authorizes the
fallback. The Mac flow should export browser state from Greg's already logged-in
Chrome profile; it must not ask Greg for a password or perform a generic VNC
sign-in. If Google requires a live second factor, create a narrow human task for
the 2FA code or approval action only.

## Known Failure Modes

- Direct Orgo login cannot synthesize Greg's Google browser session from OAuth
  client secrets or refresh tokens.
- The Orgo exec environment does not expose `INTERNAL_CRON_SECRET` by default.
- Orca DOM PIN entry can fail to trigger the React submit path in headless
  Chrome; use `/api/auth/login` instead.
- Hub currently fails closed to `/auth` until a Mac-sourced authenticated Hub /
  Google cookie set is exported.
