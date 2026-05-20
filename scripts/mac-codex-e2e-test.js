#!/usr/bin/env node
/**
 * mac-codex-e2e-test.js
 *
 * Runs N round-trip dispatches through the mac-codex bridge and reports
 * pass/fail + failure type for each round.
 *
 * Usage: node mac-codex-e2e-test.js [rounds=10]
 */

'use strict';

const { execFileSync } = require('child_process');
const ROUNDS      = parseInt(process.argv[2] || '10', 10);
const TIMEOUT_MS  = 420_000; // 7 min — matches bridge CODEX_TIMEOUT_SEC + buffer
const POLL_MS     = 3_000;
const TEST_PROMPT = 'Open https://example.com in Chrome, take a screenshot, reply with the screenshot path.';

function bus(...args) {
  return execFileSync('cortextos', ['bus', ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
  }).trim();
}

function sendMessage(to, text) {
  // Returns the message ID
  return bus('send-message', to, 'normal', text);
}

function checkInbox() {
  try {
    const raw = bus('check-inbox');
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function ackInbox(id) {
  try { bus('ack-inbox', id); } catch { /* non-fatal */ }
}

/**
 * Wait for a reply to a specific message ID in dev's inbox.
 * Returns { ok, text, durationMs, failureType }.
 */
async function waitForReply(sentMsgId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = checkInbox();
    for (const msg of msgs) {
      // Bridge replies with reply_to = the message we sent
      if (msg.reply_to === sentMsgId || (msg.from === 'mac-codex' && msg.reply_to === sentMsgId)) {
        ackInbox(msg.id);
        const text = msg.text || '';
        const ok   = !text.startsWith('ERROR:') && !text.startsWith('mac-codex error:');
        const failureType = ok ? null : classifyFailure(text);
        return { ok, text: text.slice(0, 500), failureType };
      }
      // Also check for any mac-codex reply that arrived without reply_to (defensive)
      if (msg.from === 'mac-codex' && !msg.reply_to) {
        ackInbox(msg.id);
        const text = msg.text || '';
        const ok   = !text.startsWith('ERROR:') && !text.startsWith('mac-codex error:');
        return { ok, text: text.slice(0, 500), failureType: ok ? null : classifyFailure(text) };
      }
    }
    await sleep(POLL_MS);
  }
  return { ok: false, text: '(timeout — no reply received)', failureType: 'TIMEOUT' };
}

function classifyFailure(text) {
  if (!text) return 'EMPTY_REPLY';
  if (text.includes('Connection refused') || text.includes('No route to host') ||
      text.includes('ssh: connect') || text.includes('Could not resolve')) return 'SSH_OFFLINE';
  if (text.includes('timed out') || text.includes('timeout')) return 'TIMEOUT';
  if (text.includes('base64') || text.includes('parse')) return 'ENCODING_ERROR';
  if (text.includes('codex-dispatch') || text.includes('No such file')) return 'DISPATCH_SCRIPT_MISSING';
  if (text.includes('exited') || text.includes('exit code')) return 'CODEX_EXIT_ERROR';
  if (text.includes('Screenshot') || text.includes('.png') || text.includes('.jpg')) return null; // looks like success
  return 'UNKNOWN';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const results = [];
  console.log(`\n=== mac-codex E2E test: ${ROUNDS} rounds ===`);
  console.log(`Prompt: "${TEST_PROMPT}"\n`);

  for (let i = 1; i <= ROUNDS; i++) {
    process.stdout.write(`Round ${i}/${ROUNDS}: sending... `);
    const t0 = Date.now();

    let sentId;
    try {
      sentId = sendMessage('mac-codex', TEST_PROMPT);
    } catch (e) {
      const result = { round: i, ok: false, failureType: 'BUS_SEND_FAILED', text: e.message.slice(0, 200), durationMs: Date.now() - t0 };
      results.push(result);
      console.log(`FAIL (BUS_SEND_FAILED): ${result.text}`);
      continue;
    }

    // Strip any extra output — bus send-message may print the ID with surrounding text
    const msgId = sentId.split('\n').find(l => l.match(/^\d{13}-\w+-\w+$/)) || sentId.trim();

    const reply = await waitForReply(msgId, TIMEOUT_MS);
    const durationMs = Date.now() - t0;
    const result = { round: i, ok: reply.ok, failureType: reply.failureType, text: reply.text, durationMs };
    results.push(result);

    const status = reply.ok ? 'PASS' : `FAIL (${reply.failureType})`;
    console.log(`${status} — ${(durationMs / 1000).toFixed(1)}s`);
    if (!reply.ok) console.log(`  └─ ${reply.text.slice(0, 200)}`);

    // Brief gap between rounds to avoid hammering the bridge
    if (i < ROUNDS) await sleep(2_000);
  }

  // Summary
  const passed  = results.filter(r => r.ok).length;
  const failed  = results.filter(r => !r.ok).length;
  const byType  = {};
  results.filter(r => !r.ok).forEach(r => {
    byType[r.failureType] = (byType[r.failureType] || 0) + 1;
  });
  const avgMs = results.reduce((s, r) => s + r.durationMs, 0) / results.length;

  console.log('\n=== RESULTS ===');
  console.log(`Pass: ${passed}/${ROUNDS}  Fail: ${failed}/${ROUNDS}`);
  console.log(`Avg duration: ${(avgMs / 1000).toFixed(1)}s`);
  if (Object.keys(byType).length) {
    console.log('Failure breakdown:');
    Object.entries(byType).forEach(([type, count]) => console.log(`  ${type}: ${count}`));
  }
  console.log('\nPer-round detail:');
  results.forEach(r => {
    const label = r.ok ? '✓' : `✗ (${r.failureType})`;
    console.log(`  R${r.round}: ${label} — ${(r.durationMs / 1000).toFixed(1)}s`);
  });

  return passed;
}

main().then(passed => {
  process.exit(passed === ROUNDS ? 0 : 1);
}).catch(e => {
  console.error('Test harness fatal:', e.message);
  process.exit(2);
});
