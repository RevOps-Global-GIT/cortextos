# LastPass Agent Access Proxy Spec

Generated: 2026-05-18T06:35Z

## Objective

Give agents a controlled fallback path for long-tail credentials that are already available to Greg's authenticated LastPass Chrome extension on the Mac, without storing or asking for the LastPass master password.

Operator-facing command:

```bash
cortextos bus lastpass-cred <service>
```

Successful output is the credential only on stdout. Status, approval, and errors go to stderr or the bus audit trail.

## Architecture

- Agent runs `cortextos bus lastpass-cred <service>`.
- Bus wrapper in `src/bus/lastpass-cred.ts` validates the service key, checks first-access approval state, writes an audit entry, and SSHes to Greg's Mac.
- Mac fetcher path defaults to `/Users/gregharned/.cortextos/bin/lastpass-cred-fetch.sh`.
- Repo source for the Mac fetcher is `scripts/lastpass-cred-fetch.sh`.
- Fetcher preference order:
  - `lpass show --password <service>` when `lpass` exists and is already unlocked.
  - Chrome LastPass extension fallback on Greg's Mac. The scaffold opens the vault search surface through Chrome/AppleScript and fails closed until a validated selector flow is configured.

## Security Model

- The master password is never requested, persisted, logged, or passed over SSH.
- The bus command refuses service names outside a narrow character allowlist.
- First access per service requires a normal cortextOS approval with Telegram Approve/Deny buttons.
- Approval descriptions include a stable marker: `lastpass_credential_first_access service=<service>`.
- Resolved approvals are reused for subsequent access to the same service.
- Credential values are never written to the audit log.
- The Mac fetcher must return only the credential on stdout. Diagnostics must go to stderr.
- The fallback extension path is fail-closed until proven; no blind clipboard scraping is enabled.

## Audit Pattern

Audit file:

```text
~/.cortextos/<instance>/orgs/<org>/analytics/security/lastpass-cred-access.jsonl
```

Each line records:

- `ts`
- `agent`
- `org`
- `event`
- `service`
- `approval_id` when applicable
- bounded error text on failure

Events:

- `approval_requested`
- `approval_pending`
- `approval_rejected`
- `fetch_started`
- `fetch_succeeded`
- `fetch_failed`

## First-Access Flow

1. Agent requests `cortextos bus lastpass-cred <service>`.
2. If no prior approval exists, the command creates approval `First LastPass credential access: <service>` and exits non-zero.
3. Greg approves or denies using Telegram buttons or dashboard approval controls.
4. Agent reruns the command.
5. If approved, the bus wrapper writes `fetch_started`, calls the Mac fetcher, writes success/failure, and returns only the credential to stdout.

## Recovery If Compromised

- Disable the CLI command or remove the Mac script path immediately.
- Revoke or deny pending LastPass first-access approvals in the dashboard.
- Review `lastpass-cred-access.jsonl` for accessed service keys and timestamps.
- Rotate affected downstream service credentials in LastPass and any mirrored `secrets.env` entries.
- Rotate SSH access to `gregs-mac` if there is any sign of host compromise.
- Re-enable only after confirming the Mac LastPass session and Chrome profile are clean.

## Current Scaffold Status

- Bus wrapper and audit/approval flow are scaffolded.
- Mac fetcher source is present at `scripts/lastpass-cred-fetch.sh`.
- The fetcher is usable immediately if `lpass` is installed and already unlocked on the Mac.
- Chrome extension fallback is intentionally gated: it opens LastPass vault search but exits with code `70` until selector-level extraction is validated on Greg's Mac.
