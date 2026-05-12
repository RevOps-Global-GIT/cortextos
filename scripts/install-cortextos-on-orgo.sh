#!/usr/bin/env bash
# install-cortextos-on-orgo.sh
#
# Runs ON an Orgo VM to install Node.js + cortextos + a systemd unit.
# Called by `cortextos provision-orgo` via the Orgo /exec API (Python wrapper).
# Assumes: Ubuntu/Debian base image; run as root (Orgo VMs boot as root).
#
# Usage (direct, for testing): bash install-cortextos-on-orgo.sh [--agent-name <name>]
# Env overrides: CORTEXTOS_VERSION (npm tag, default: latest)

set -euo pipefail

AGENT_NAME="${1:-cortextos-agent}"
CORTEXTOS_VERSION="${CORTEXTOS_VERSION:-latest}"
NODE_MAJOR="${NODE_MAJOR:-20}"

# ---------------------------------------------------------------------------
# 1. Normalize PATH — Orgo /exec ships a minimal environment
# ---------------------------------------------------------------------------
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive

echo "[provision] Starting cortextos-on-orgo install (agent: $AGENT_NAME)"

# ---------------------------------------------------------------------------
# 2. Sync clock from Google HTTP Date header
#    Orgo VM clocks drift and can break HTTPS cert validation downstream.
# ---------------------------------------------------------------------------
NEW_DATE=$(curl -sI http://www.google.com 2>/dev/null \
  | awk -F': ' '/^[Dd]ate:/ {print $2}' \
  | tr -d '\r' | head -n1 || true)
[ -n "$NEW_DATE" ] && date -s "$NEW_DATE" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 3. Kill stale apt/dpkg locks from any prior timed-out install attempt
# ---------------------------------------------------------------------------
pkill -9 -x apt-get >/dev/null 2>&1 || true
pkill -9 -x dpkg    >/dev/null 2>&1 || true
sleep 1
rm -f /var/lib/apt/lists/lock \
      /var/lib/dpkg/lock-frontend \
      /var/lib/dpkg/lock >/dev/null 2>&1 || true
dpkg --configure -a >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 4. Install Node.js via NodeSource if not present / wrong version
# ---------------------------------------------------------------------------
need_node=false
if ! command -v node >/dev/null 2>&1; then
  need_node=true
else
  CURRENT_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
  [ "$CURRENT_MAJOR" -lt "$NODE_MAJOR" ] && need_node=true || true
fi

if [ "$need_node" = "true" ]; then
  echo "[provision] Installing Node.js $NODE_MAJOR via NodeSource..."
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq curl ca-certificates gnupg >/dev/null 2>&1
  mkdir -p /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] \
https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
fi

echo "[provision] Node: $(node --version)  npm: $(npm --version)"

# ---------------------------------------------------------------------------
# 5. Install cortextos globally
#    Prefer a pre-staged tarball at /tmp/cortextos.tgz (written by provision-orgo
#    before running this script).  Fall back to a GH_TOKEN-authenticated git
#    install if the tarball is absent.
# ---------------------------------------------------------------------------
if [ -f /tmp/cortextos.tgz ]; then
  echo "[provision] Installing cortextos from tarball /tmp/cortextos.tgz..."
  npm install -g /tmp/cortextos.tgz --loglevel=warn 2>&1
elif [ -n "${GH_TOKEN:-}" ]; then
  echo "[provision] No tarball found — installing cortextos from git (tag: ${CORTEXTOS_VERSION})..."
  npm install -g \
    "https://x-access-token:${GH_TOKEN}@github.com/RevOps-Global-GIT/cortextos.git#main" \
    --loglevel=warn 2>&1
else
  echo "[provision] ERROR: /tmp/cortextos.tgz not found and GH_TOKEN not set — cannot install cortextos."
  exit 1
fi

echo "[provision] cortextos: $(cortextos --version 2>/dev/null || echo 'installed')"

# ---------------------------------------------------------------------------
# 6. Create agent home directory
# ---------------------------------------------------------------------------
AGENT_HOME="/opt/cortextos-agents/${AGENT_NAME}"
mkdir -p "${AGENT_HOME}"
echo "[provision] Agent home: ${AGENT_HOME}"

# ---------------------------------------------------------------------------
# 7. Write systemd unit
# ---------------------------------------------------------------------------
UNIT_NAME="cortextos-${AGENT_NAME}"
UNIT_FILE="/etc/systemd/system/${UNIT_NAME}.service"

cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=cortextOS agent: ${AGENT_NAME}
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${AGENT_HOME}
EnvironmentFile=-${AGENT_HOME}/.env
ExecStart=$(command -v node) $(command -v cortextos) start ${AGENT_NAME} --foreground
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${UNIT_NAME}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${UNIT_NAME}.service" >/dev/null 2>&1

echo "[provision] systemd unit enabled: ${UNIT_NAME}.service"
echo "[provision] Install complete."
echo "[provision] Next: write ${AGENT_HOME}/.env with BOT_TOKEN, CHAT_ID, CTX_ORG, etc."
echo "[provision] Then: systemctl start ${UNIT_NAME}"
