#!/usr/bin/env node
/**
 * orgo-codex-bridge — daemon that forwards bus messages to the Orgo VM's
 * Claude Code CLI (claude -p), running tasks headlessly without touching Greg's Mac.
 *
 * Architecture:
 *   Any agent sends:  cortextos bus send-message orgo-codex normal '<prompt>'
 *   Bridge receives:  inbox message via two channels:
 *     1. PTY stdin   — daemon fast-checker injects messages here (primary path)
 *     2. poll        — check-inbox fallback for any messages fast-checker missed
 *   Bridge executes:  Orgo VM exec API → claude --print '<prompt>' (headless, background tmux)
 *   Bridge replies:   cortextos bus send-message <from> normal '<session_id>' <msg_id>
 *                     Caller gets a session name; output accumulates in /tmp/orgo-<id>.log
 *
 * Uses Claude Code CLI (not Codex CLI) because:
 *   - ANTHROPIC_API_KEY is available in secrets.env
 *   - codex CLI requires ChatGPT OAuth for support@revopsglobal.com (pending HUMAN task)
 *   - claude -p is fully headless, no interactive auth needed
 * When support@ ChatGPT OAuth is completed, swap to: codex exec --skip-git-repo-check
 *
 * Set runtime='script' + script_path='scripts/orgo-codex-bridge.js' in config.json.
 */

'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const AGENT_NAME = process.env.CTX_AGENT_NAME || 'orgo-codex';
const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const ORGO_TIMEOUT_MS = 20_000; // HTTP exec API is fast — just starts tmux session

// Orgo VM config — Codex-ComputerUse VM
const ORGO_VM_ID = '3ec3d7f3-a5da-4678-8b25-ce28b7aed829';
const ORGO_CONTROL_URL = 'http://91.242.214.39:43585';

// Loaded lazily from secrets.env
let _orgoVncPw = null;
let _anthropicApiKey = null;

function loadSecrets() {
  if (_anthropicApiKey) return;
  const candidates = [
    path.join(__dirname, '..', 'orgs', 'revops-global', 'secrets.env'),
    path.join(process.env.HOME || '/root', 'cortextos', 'orgs', 'revops-global', 'secrets.env'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
      if (!m) continue;
      if (m[1] === 'ANTHROPIC_API_KEY') _anthropicApiKey = m[2].trim();
    }
    break;
  }
  if (!_anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not found in secrets.env');
}

async function fetchVncPassword() {
  const orgoKey = (() => {
    const candidates = [
      path.join(__dirname, '..', 'orgs', 'revops-global', 'secrets.env'),
      path.join(process.env.HOME || '/root', 'cortextos', 'orgs', 'revops-global', 'secrets.env'),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf-8');
      for (const line of content.split('\n')) {
        const m = line.match(/^ORGO_API_KEY=(.+)$/);
        if (m) return m[1].trim();
      }
    }
    throw new Error('ORGO_API_KEY not found in secrets.env');
  })();

  const res = await fetch(`https://www.orgo.ai/api/computers/${ORGO_VM_ID}`, {
    headers: { Authorization: `Bearer ${orgoKey}` },
  });
  if (!res.ok) throw new Error(`Orgo API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  _orgoVncPw = data.vnc_password;
  return _orgoVncPw;
}

/**
 * Execute a shell command on the Orgo VM via its direct control HTTP API.
 * Returns { output, exit_code }.
 */
async function orgoExec(command, timeout = ORGO_TIMEOUT_MS) {
  if (!_orgoVncPw) await fetchVncPassword();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${ORGO_CONTROL_URL}/bash`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${_orgoVncPw}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Orgo exec HTTP ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`Orgo exec timed out after ${timeout}ms`);
    throw e;
  }
}

// Tracks already-processed message IDs to deduplicate across both input channels
const processed = new Set();

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] [orgo-codex-bridge] ${msg}\n`);
}

function bus(...args) {
  return execFileSync('cortextos', ['bus', ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
  }).trim();
}

function updateHeartbeat(status) {
  try {
    bus('update-heartbeat', status);
  } catch (e) {
    log(`heartbeat failed: ${e.message.slice(0, 100)}`);
  }
}

function checkInbox() {
  try {
    const raw = bus('check-inbox');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Dispatch a prompt to the Orgo VM's codex CLI via a background tmux session.
 * - Prompt is written to a temp file to avoid shell quoting issues.
 * - tmux session name is returned as the "session ID" (like thread ID in mac-codex).
 * - codex output accumulates in /tmp/orgo-<nonce>.log on the VM.
 * - Fire-and-forget: bridge returns as soon as tmux session is started.
 */
async function execOnOrgo(prompt) {
  loadSecrets();
  const nonce = Date.now();
  const promptFile = `/tmp/orgo-prompt-${nonce}.txt`;
  const logFile = `/tmp/orgo-session-${nonce}.log`;
  const sessionName = `orgo-${nonce}`;

  // Write prompt to temp file on Orgo VM (base64 to avoid quoting issues)
  const promptB64 = Buffer.from(prompt).toString('base64');
  const writeResult = await orgoExec(
    `echo '${promptB64}' | base64 -d > ${promptFile} && echo ok`
  );
  if (!writeResult.output?.includes('ok')) {
    throw new Error(`Failed to write prompt file: ${JSON.stringify(writeResult)}`);
  }

  // Launch codex exec in a detached tmux session — fire-and-forget
  // Uses claude -p (Claude Code CLI) — swap to `codex exec --skip-git-repo-check`
  // once support@revopsglobal.com ChatGPT OAuth is completed on this VM.
  const codexCmd = [
    `ANTHROPIC_API_KEY=${_anthropicApiKey}`,
    'claude --print',
    `< ${promptFile}`,
    `> ${logFile} 2>&1`,
    `; rm -f ${promptFile}`,
  ].join(' ');

  const tmuxCmd = `tmux new-session -d -s '${sessionName}' '${codexCmd}'`;
  const tmuxResult = await orgoExec(tmuxCmd);

  if (tmuxResult.exit_code !== 0) {
    throw new Error(`tmux start failed: ${tmuxResult.output?.slice(0, 200)}`);
  }

  return { sessionName, logFile };
}

async function processMessage(msg) {
  const { id, from, text } = msg;
  if (processed.has(id)) return;
  processed.add(id);
  if (processed.size > 1000) {
    const oldest = [...processed].slice(0, 500);
    oldest.forEach((k) => processed.delete(k));
  }

  const preview = (text || '').slice(0, 80);
  log(`Processing msg ${id} from ${from}: ${preview}...`);

  const start = Date.now();
  let result;
  let ok = false;

  try {
    const { sessionName, logFile } = await execOnOrgo(text || '');
    result = `dispatched — claude running in Orgo VM (session=${sessionName}, log=${logFile})`;
    ok = true;
    log(`Dispatched in ${((Date.now() - start) / 1000).toFixed(1)}s — ${sessionName}`);
  } catch (e) {
    result = `orgo-codex error: ${e.message.slice(0, 500)}`;
    log(`Error: ${result}`);
    // Alert orchestrator so it can reroute to mac-codex
    try {
      bus('send-message', 'orchestrator', 'high',
        `orgo-codex unavailable: ${e.message.slice(0, 200)}. Dispatch for msg ${id} from ${from} dropped. Reroute to mac-codex.`);
    } catch { /* non-fatal */ }
  }

  try {
    bus('send-message', from, 'normal', ok ? result : `ERROR: ${result}`, id);
  } catch (e) {
    log(`Reply failed: ${e.message.slice(0, 100)}`);
  }

  try {
    bus('ack-inbox', id);
  } catch (e) {
    log(`ACK failed for ${id}: ${e.message.slice(0, 100)}`);
  }

  try {
    bus('log-event', 'action', 'orgo_codex_dispatch', ok ? 'info' : 'warning',
      '--meta', JSON.stringify({ from, durationMs: Date.now() - start, ok, msgId: id }));
  } catch { /* non-fatal */ }
}

function stripEscapes(str) {
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '')
    .replace(/\x1b./g, '');
}

function parseStdinMessages(buf) {
  const text = stripEscapes(buf.toString('utf-8'));
  const blocks = text.split(/(?====\s+AGENT MESSAGE)/);
  for (const block of blocks) {
    const headerMatch = block.match(/===\s+AGENT MESSAGE from (\S+)\s+\[msg_id:\s+(\S+)\]/);
    if (!headerMatch) continue;
    const from = headerMatch[1];
    const id = headerMatch[2];
    const bodyMatch = block.match(/===\n([\s\S]*?)(?:\nReply using:|$)/);
    const rawBody = bodyMatch ? bodyMatch[1].trim() : '';
    const bodyText = rawBody
      .replace(/^```[^\n]*\n/, '')
      .replace(/\n```\s*$/, '');
    if (id && from) {
      processMessage({ id, from, text: bodyText, to: AGENT_NAME, priority: 'normal', timestamp: new Date().toISOString(), reply_to: null })
        .catch((e) => log(`stdin processMessage uncaught: ${e.message}`));
    }
  }
}

async function main() {
  log(`Starting (agent=${AGENT_NAME})`);
  updateHeartbeat('online — waiting for dispatch');

  let stdinBuf = '';
  if (process.stdin.isTTY !== false) {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      stdinBuf += chunk;
      if (stdinBuf.includes('=== AGENT MESSAGE') && stdinBuf.includes('\nReply using:')) {
        parseStdinMessages(Buffer.from(stdinBuf));
        stdinBuf = '';
      }
    });
    process.stdin.resume();
  }

  let lastHeartbeat = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
      updateHeartbeat('online — waiting for dispatch');
      lastHeartbeat = Date.now();
    }

    const messages = checkInbox();
    for (const msg of messages) {
      processMessage(msg).catch((e) => log(`processMessage uncaught: ${e.message}`));
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  process.stderr.write(`[orgo-codex-bridge] Fatal: ${e.message}\n`);
  process.exit(1);
});
