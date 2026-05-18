#!/usr/bin/env bash
set -euo pipefail

# Fetch one LastPass credential on Greg's Mac.
#
# Contract:
# - argv[1] is a service/item name.
# - stdout is the credential only.
# - stderr is status/errors only.
# - never prompts for or stores the LastPass master password.
#
# Preferred path is the official `lpass` CLI when an unlocked session already
# exists. The Chrome-extension fallback is intentionally fail-closed until the
# extension DOM selector contract is validated on the Mac; it opens the vault
# search surface for manual/probe validation but does not scrape blindly.

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "usage: $0 <service>" >&2
  exit 64
fi

if [[ "$SERVICE" =~ [^A-Za-z0-9._/@:+-] ]]; then
  echo "refusing service name with unsupported characters: $SERVICE" >&2
  exit 64
fi

LPASS_ENTRY_PREFIX="${LPASS_ENTRY_PREFIX:-}"
ENTRY="${LPASS_ENTRY_PREFIX}${SERVICE}"

if command -v lpass >/dev/null 2>&1; then
  if lpass status >/dev/null 2>&1; then
    exec lpass show --password "$ENTRY"
  fi
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "LastPass Chrome-extension fallback requires macOS; lpass is unavailable or locked" >&2
  exit 69
fi

LASTPASS_EXTENSION_ID="${LASTPASS_EXTENSION_ID:-hdokiejnpimakedhajhdlcegeplioahd}"
VAULT_URL="chrome-extension://${LASTPASS_EXTENSION_ID}/vault.html?search=${SERVICE}"

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript not available for Chrome LastPass extension fallback" >&2
  exit 69
fi

osascript >/dev/null <<OSA
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  set URL of active tab of front window to "$VAULT_URL"
end tell
OSA

cat >&2 <<EOF
LastPass extension fallback opened Chrome vault search for "$SERVICE" but scraping is not enabled yet.
Install/unlock `lpass` on the Mac or configure a validated Chrome CDP selector flow before using this path unattended.
EOF
exit 70
