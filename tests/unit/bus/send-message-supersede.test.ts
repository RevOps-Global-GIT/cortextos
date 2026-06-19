/**
 * Guards the supersede message capability on the cortextos bus.
 *
 * When a message carries a `supersedes` field, checkInbox() must discard all
 * queued messages from the SAME sender whose priority is at or below the
 * threshold — but must never affect messages from other senders.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox } from '../../../src/bus/message';
import type { BusPaths } from '../../../src/types';

function makePaths(testDir: string, agent: string): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    deliverablesDir: join(testDir, 'deliverables'),
  };
}

describe('supersede message type', () => {
  let testDir: string;
  let senderPaths: BusPaths;
  let otherSenderPaths: BusPaths;
  let receiverPaths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-supersede-test-'));
    senderPaths = makePaths(testDir, 'sender');
    otherSenderPaths = makePaths(testDir, 'other');
    receiverPaths = makePaths(testDir, 'receiver');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('discards queued lower-priority messages from same sender', () => {
    // Queue 3 normal messages from sender→receiver
    sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'stale 1');
    sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'stale 2');
    sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'stale 3');
    // Send 1 urgent supersede message
    sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'new direction', undefined, undefined, 'normal');

    const messages = checkInbox(receiverPaths);

    // Only the supersede message survives
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe('new direction');
    expect(messages[0].supersedes).toBe('normal');

    // Superseded messages moved to processed (not inflight)
    const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));
    const processedFiles = readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'));
    expect(inflightFiles.length).toBe(1); // just the supersede msg itself (in inflight, awaiting ack)
    expect(processedFiles.length).toBe(3); // the 3 discarded normals
  });

  it('does not affect messages from other senders', () => {
    sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'stale from sender');
    sendMessage(otherSenderPaths, 'other', 'receiver', 'normal', 'keep from other');
    sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'supersede', undefined, undefined, 'normal');

    const messages = checkInbox(receiverPaths);

    expect(messages.length).toBe(2); // supersede + other's message
    const texts = messages.map(m => m.text);
    expect(texts).toContain('supersede');
    expect(texts).toContain('keep from other');
    expect(texts).not.toContain('stale from sender');
  });

  it('supersedes only messages at or below the threshold priority', () => {
    // high priority (PRIORITY_MAP=1) is ABOVE normal threshold (PRIORITY_MAP=2)
    // so high messages are NOT discarded
    sendMessage(senderPaths, 'sender', 'receiver', 'high', 'keep - above threshold');
    sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'discard - at threshold');
    sendMessage(senderPaths, 'sender', 'receiver', 'low', 'discard - below threshold');
    // supersede at 'normal' means: discard normal (==2) and low (==3), keep high (==1)
    sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'supersede normal+low', undefined, undefined, 'normal');

    const messages = checkInbox(receiverPaths);

    // high is kept (PRIORITY_MAP[high]=1 < PRIORITY_MAP[normal]=2), normal+low discarded
    expect(messages.length).toBe(2);
    const texts = messages.map(m => m.text);
    expect(texts).toContain('supersede normal+low');
    expect(texts).toContain('keep - above threshold');
    expect(texts).not.toContain('discard - at threshold');
    expect(texts).not.toContain('discard - below threshold');
  });
});
