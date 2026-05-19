#!/usr/bin/env node
/**
 * mac-codex-bridge — thin daemon that forwards bus messages directly to
 * Greg's Mac Codex app via SSH. No Claude Code REPL overhead.
 *
 * Architecture:
 *   Any agent sends:  cortextos bus send-message mac-codex normal '<prompt>'
 *   Bridge receives:  inbox message via two channels:
 *     1. PTY stdin   — daemon fast-checker injects messages here (primary path)
 *     2. poll        — check-inbox fallback for any messages fast-checker missed
 *   Bridge executes:  ssh gregs-mac codex-dispatch.sh <prompt>
 *   Bridge replies:   cortextos bus send-message <from> normal '<result>' <msg_id>
 *
 * The bridge bypasses the Orgo gate — it is explicitly Mac-first by design.
 * Set runtime='script' + script_path='scripts/mac-codex-bridge.js' in config.json.
 */

'use strict';

const { execFileSync, spawn } = require('child_process');

const AGENT_NAME = process.env.CTX_AGENT_NAME || 'mac-codex';
const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DISPATCH_SCRIPT = '/Users/gregharned/work/team-brain/scripts/codex-dispatch.sh';
const SSH_HOST = 'gregs-mac';
const CODEX_TIMEOUT_SEC = 120;
const SSH_TIMEOUT_MS = (CODEX_TIMEOUT_SEC + 30) * 1_000;

// SSH connection failure patterns — used to distinguish offline vs execution errors
const SSH_CONN_ERROR_PATTERNS = [
  'Connection refused',
  'No route to host',
  'Connection timed out',
  'ssh: connect to host',
  'Could not resolve hostname',
  'Network is unreachable',
  'Host is down',
];

function isConnectionError(err) {
  if (!err) return false;
  const msg = (err.message || '') + (err.stderr || '');
  return SSH_CONN_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Async wrapper around child_process.spawn — resolves with stdout string or
 * rejects with an Error whose .stderr property holds stderr output.
 */
function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { timeout, maxBuffer = 10 * 1024 * 1024 } = opts;
    const chunks = [];
    const errChunks = [];
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let timedOut = false;
    let timer;
    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);
    }

    child.stdout.on('data', (d) => {
      chunks.push(d);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      if (total > maxBuffer) {
        child.kill('SIGKILL');
        reject(new Error(`Output exceeded maxBuffer (${maxBuffer} bytes)`));
      }
    });
    child.stderr.on('data', (d) => errChunks.push(d));

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new Error(`Process timed out after ${timeout}ms`));
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
      if (code !== 0) {
        const err = new Error(`ssh exited ${code}: ${stderr.slice(0, 500)}`);
        err.stderr = stderr;
        return reject(err);
      }
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    });

    child.on('error', reject);
  });
}

// Tracks already-processed message IDs to deduplicate across both input channels
const processed = new Set();

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] [mac-codex-bridge] ${msg}\n`);
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
 * SSH to gregs-mac and run codex-dispatch.sh with the given prompt.
 * Prompt is base64-encoded to survive any quoting in the remote shell.
 * noPlugin=true skips the @Computer Use plugin (code-only tasks).
 * noPlugin=false includes the Computer Use plugin (UI/screen tasks).
 * Returns a Promise — callers do NOT block the event loop while SSH is in-flight.
 */
function execOnMac(prompt, noPlugin) {
  const b64 = Buffer.from(prompt, 'utf-8').toString('base64');
  const parts = [DISPATCH_SCRIPT];
  if (noPlugin) parts.push('--no-plugin');
  parts.push('--timeout', String(CODEX_TIMEOUT_SEC));
  // base64-decode the prompt on the remote side — avoids all shell quoting issues
  parts.push(`"$(printf '%s' ${b64} | base64 -d)"`);
  const remoteCmd = parts.join(' ');

  return spawnAsync('ssh', [
    '-n',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=2',
    SSH_HOST,
    remoteCmd,
  ], {
    timeout: SSH_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Infer whether the prompt needs the Computer Use plugin (GUI/screen) or
 * can run as a code-only task (no plugin, faster).
 */
function wantsComputerUse(prompt) {
  const lower = prompt.toLowerCase();
  return (
    lower.includes('@computer use') ||
    lower.includes('screenshot') ||
    lower.includes('click ') ||
    lower.includes('open the ') ||
    lower.includes('navigate to ') ||
    lower.includes('in chrome') ||
    lower.includes('in safari') ||
    lower.includes('in the browser')
  );
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
    const noPlugin = !wantsComputerUse(text || '');
    result = await execOnMac(text || '', noPlugin);
    ok = true;
    log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (e) {
    result = `mac-codex error: ${e.message.slice(0, 500)}`;
    log(`Error: ${result}`);
    if (isConnectionError(e)) {
      // Alert orchestrator so it can reroute or notify user
      try {
        bus('send-message', 'orchestrator', 'high',
          `mac-codex offline: SSH to ${SSH_HOST} failed. Dispatch for msg ${id} from ${from} dropped.`);
      } catch { /* non-fatal — orchestrator may itself be down */ }
    }
  }

  // Reply to sender
  try {
    bus('send-message', from, 'normal', ok ? result : `ERROR: ${result}`, id);
  } catch (e) {
    log(`Reply failed: ${e.message.slice(0, 100)}`);
  }

  // ACK the message (prevents re-delivery)
  try {
    bus('ack-inbox', id);
  } catch (e) {
    log(`ACK failed for ${id}: ${e.message.slice(0, 100)}`);
  }

  // Log telemetry event
  try {
    bus('log-event', 'action', 'mac_codex_dispatch', ok ? 'info' : 'warning',
      '--meta', JSON.stringify({ from, durationMs: Date.now() - start, ok, msgId: id }));
  } catch { /* non-fatal */ }
}

/**
 * Parse messages injected by the daemon's fast-checker via PTY stdin.
 *
 * Fast-checker writes the cortextos agent message format:
 *   === AGENT MESSAGE from <from> [msg_id: <id>] ===
 *   <text lines>
 *   Reply using: cortextos bus send-message <from> normal '<reply>' <id>
 *
 * We extract from/id/text and feed into processMessage().
 */
/**
 * Strip ANSI/VT100 escape sequences (including bracketed-paste markers ESC[200~ / ESC[201~)
 * that the daemon fast-checker injects around PTY-written messages.
 */
function stripEscapes(str) {
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '')  // CSI sequences (including ESC[200~ ESC[201~)
    .replace(/\x1b./g, '');                    // any remaining ESC + one char
}

function parseStdinMessages(buf) {
  const text = stripEscapes(buf.toString('utf-8'));
  // Split on message boundaries
  const blocks = text.split(/(?====\s+AGENT MESSAGE)/);
  for (const block of blocks) {
    const headerMatch = block.match(/===\s+AGENT MESSAGE from (\S+)\s+\[msg_id:\s+(\S+)\]/);
    if (!headerMatch) continue;
    const from = headerMatch[1];
    const id = headerMatch[2];
    // Body: lines between header and "Reply using:" or end.
    // Fast-checker wraps the body in triple-backtick code fences; strip them.
    const bodyMatch = block.match(/===\n([\s\S]*?)(?:\nReply using:|$)/);
    const rawBody = bodyMatch ? bodyMatch[1].trim() : '';
    const bodyText = rawBody
      .replace(/^```[^\n]*\n/, '')  // strip opening ``` or ```lang
      .replace(/\n```\s*$/, '');    // strip closing ```
    if (id && from) {
      processMessage({ id, from, text: bodyText, to: AGENT_NAME, priority: 'normal', timestamp: new Date().toISOString(), reply_to: null })
        .catch((e) => log(`stdin processMessage uncaught: ${e.message}`));
    }
  }
}

async function main() {
  log(`Starting (agent=${AGENT_NAME})`);
  updateHeartbeat('online — waiting for dispatch');

  // Listen on stdin for fast-checker message injections (PTY stdin channel)
  let stdinBuf = '';
  if (process.stdin.isTTY !== false) {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      stdinBuf += chunk;
      // Wait for a complete block: both the header AND the reply-using footer must be
      // present before parsing. Multi-line messages arrive in multiple PTY chunks;
      // parsing on the first chunk (header only) gives empty body text.
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

    // Fallback: poll inbox for any messages fast-checker missed
    const messages = checkInbox();
    for (const msg of messages) {
      // fire-and-forget — concurrent dispatches don't block each other
      processMessage(msg).catch((e) => log(`processMessage uncaught: ${e.message}`));
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  process.stderr.write(`[mac-codex-bridge] Fatal: ${e.message}\n`);
  process.exit(1);
});
