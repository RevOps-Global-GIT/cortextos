import { describe, it, expect } from 'vitest';
import {
  HISTORY_SIZE,
  REPETITION_BLOCK,
  PINGPONG_BLOCK,
  hashArgs,
  countRepetitions,
  detectPingPong,
  checkEssential,
  type ToolCallRecord,
} from '../../../src/hooks/hook-loop-detector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(toolName: string, argsHash = '', ts = 0): ToolCallRecord {
  return { toolName, argsHash, ts };
}

/**
 * Build an alternating history of toolA / toolB for `pairs` pair cycles.
 * e.g. buildAlternating('A', 'B', 3) → [A, B, A, B, A, B]
 */
function buildAlternating(toolA: string, toolB: string, pairs: number): ToolCallRecord[] {
  const history: ToolCallRecord[] = [];
  for (let i = 0; i < pairs; i++) {
    history.push(makeRecord(toolA));
    history.push(makeRecord(toolB));
  }
  return history;
}

// ---------------------------------------------------------------------------
// hashArgs
// ---------------------------------------------------------------------------

describe('hashArgs', () => {
  it('returns empty string for null', () => {
    expect(hashArgs(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(hashArgs(undefined)).toBe('');
  });

  it('produces the same hash regardless of key order', () => {
    const h1 = hashArgs({ a: 1, b: 2 });
    const h2 = hashArgs({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different inputs', () => {
    expect(hashArgs({ cmd: 'ls' })).not.toBe(hashArgs({ cmd: 'pwd' }));
  });
});

// ---------------------------------------------------------------------------
// countRepetitions
// ---------------------------------------------------------------------------

describe('countRepetitions', () => {
  it('counts zero when tool not in history', () => {
    const history = [makeRecord('Read', 'abc'), makeRecord('Bash', 'def')];
    expect(countRepetitions(history, 'Write', 'abc')).toBe(0);
  });

  it('counts exact (tool, argsHash) matches', () => {
    const history = [
      makeRecord('Bash', 'aaa'),
      makeRecord('Bash', 'aaa'),
      makeRecord('Bash', 'bbb'), // different hash
      makeRecord('Bash', 'aaa'),
    ];
    expect(countRepetitions(history, 'Bash', 'aaa')).toBe(3);
  });

  it('returns REPETITION_BLOCK or more for repeated identical calls', () => {
    const hash = hashArgs({ command: 'npm test' });
    const history = Array.from({ length: REPETITION_BLOCK }, () => makeRecord('Bash', hash));
    expect(countRepetitions(history, 'Bash', hash)).toBe(REPETITION_BLOCK);
  });
});

// ---------------------------------------------------------------------------
// detectPingPong
// ---------------------------------------------------------------------------

describe('detectPingPong', () => {
  it('returns count 0 when history is shorter than PINGPONG_WINDOW', () => {
    const result = detectPingPong([makeRecord('A'), makeRecord('B')]);
    expect(result.count).toBe(0);
    expect(result.tools).toBeNull();
  });

  it('detects alternating pair above PINGPONG_BLOCK', () => {
    // 16 pairs = 32 entries, well above block threshold
    const history = buildAlternating('Read', 'Bash', 16);
    const result = detectPingPong(history);
    expect(result.count).toBeGreaterThanOrEqual(PINGPONG_BLOCK);
    expect(result.tools).not.toBeNull();
    expect(result.tools!.sort()).toEqual(['Bash', 'Read'].sort());
  });

  it('returns null tools when no pair dominates the window', () => {
    // Four different tools evenly spread — no pair dominates ≥80%
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 4; i++) {
      for (const t of ['A', 'B', 'C', 'D']) {
        history.push(makeRecord(t));
      }
    }
    const result = detectPingPong(history);
    expect(result.tools).toBeNull();
  });

  it('counts alternations across full history, not just window', () => {
    // 10 pairs: 20 entries — enough to reach PINGPONG_BLOCK (14 alternations)
    const history = buildAlternating('ToolX', 'ToolY', 10);
    const result = detectPingPong(history.slice(-HISTORY_SIZE));
    // 10 pairs = 19 alternations
    expect(result.count).toBe(19);
  });
});

// ---------------------------------------------------------------------------
// checkEssential
// ---------------------------------------------------------------------------

describe('checkEssential', () => {
  it('returns true for update-heartbeat bus command', () => {
    expect(checkEssential('Bash', { command: 'cortextos bus update-heartbeat "working"' })).toBe(true);
  });

  it('returns true for check-inbox bus command', () => {
    expect(checkEssential('Bash', { command: 'cortextos bus check-inbox' })).toBe(true);
  });

  it('returns true for send-telegram bus command', () => {
    expect(checkEssential('Bash', { command: 'cortextos bus send-telegram 123 "hi"' })).toBe(true);
  });

  it('returns true for vm-sync-push script', () => {
    expect(checkEssential('Bash', { command: 'node /path/to/cortextos-vm-sync-push.js' })).toBe(true);
  });

  it('returns true for sync-agent-memories script', () => {
    expect(checkEssential('Bash', { command: 'node scripts/sync-agent-memories.js' })).toBe(true);
  });

  it('returns true for mcp list_tasks tools', () => {
    expect(checkEssential('mcp__rgos__cortex_list_tasks', {})).toBe(true);
    expect(checkEssential('mcp__rgos__rgos_list_tasks', {})).toBe(true);
  });

  it('returns true for Read of HEARTBEAT.md', () => {
    expect(checkEssential('Read', { file_path: '/agents/dev/HEARTBEAT.md' })).toBe(true);
  });

  it('returns false for non-essential Bash', () => {
    expect(checkEssential('Bash', { command: 'npm test' })).toBe(false);
  });

  it('returns false for Read of arbitrary files', () => {
    expect(checkEssential('Read', { file_path: '/src/main.ts' })).toBe(false);
  });

  it('returns false for null input', () => {
    expect(checkEssential('Bash', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pair-guard regression test
// ---------------------------------------------------------------------------

describe('ping-pong pair guard (regression for false-positive block)', () => {
  it('non-pair tool is not in the detected pair when essential calls dominate history', () => {
    // Simulate cron history: mcp__list_tasks + Bash alternating at high count.
    // This is the false-positive scenario: essential calls fill history and
    // trigger ping-pong detection, but a non-pair tool (Read) should NOT be
    // implicated by the guard.
    const history = buildAlternating('mcp__rgos__cortex_list_tasks', 'Bash', 16);
    const pp = detectPingPong(history);

    // Confirm detection fires (count ≥ PINGPONG_BLOCK)
    expect(pp.count).toBeGreaterThanOrEqual(PINGPONG_BLOCK);
    expect(pp.tools).not.toBeNull();

    const [toolA, toolB] = pp.tools!;

    // The guard condition: tool_name !== toolA && tool_name !== toolB → let through
    // Read, Write, Edit, Agent are all non-pair members and should pass the guard.
    for (const nonPairTool of ['Read', 'Write', 'Edit', 'Agent', 'Glob', 'Grep']) {
      const isInPair = nonPairTool === toolA || nonPairTool === toolB;
      expect(isInPair).toBe(false);
    }
  });

  it('pair members are identified correctly and would still be blocked', () => {
    const history = buildAlternating('Read', 'Bash', 16);
    const pp = detectPingPong(history);

    expect(pp.count).toBeGreaterThanOrEqual(PINGPONG_BLOCK);
    expect(pp.tools).not.toBeNull();

    const [toolA, toolB] = pp.tools!;
    // Both pair members should be in pp.tools — the guard would NOT let them through
    const readIsInPair = 'Read' === toolA || 'Read' === toolB;
    const bashIsInPair = 'Bash' === toolA || 'Bash' === toolB;
    expect(readIsInPair).toBe(true);
    expect(bashIsInPair).toBe(true);
  });
});
