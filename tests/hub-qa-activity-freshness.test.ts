import { describe, expect, it } from 'vitest';
import {
  activityRelativeAgeMs,
  evaluateActivityFreshness,
  parseActivityAbsoluteTimestamp,
} from '../scripts/hub-qa-playwright';

describe('Hub QA activity feed freshness', () => {
  const nowMs = Date.parse('2026-06-12T01:44:25Z');

  it('prefers relative age tokens as fresh evidence', () => {
    const verdict = evaluateActivityFreshness([
      { source: 'absolute-text', label: 'Jun 12, 01:41:53' },
      { source: 'relative', label: '2m ago' },
    ], nowMs);

    expect(activityRelativeAgeMs('2m ago')).toBe(2 * 60 * 1000);
    expect(verdict.fresh).toBe(true);
    expect(verdict.recent).toBe(2);
    expect(verdict.evidence).toContain('via relative "2m ago"');
  });

  it('parses rendered UTC absolute timestamps from the activity feed', () => {
    const parsed = parseActivityAbsoluteTimestamp('Jun 12, 01:41:53', nowMs);

    expect(parsed).toBe(Date.parse('2026-06-12T01:41:53Z'));
    expect(evaluateActivityFreshness([
      { source: 'absolute-text', label: 'Jun 12, 01:41:53' },
    ], nowMs).fresh).toBe(true);
  });

  it('treats current UTC absolute timestamps as fresh', () => {
    const currentNowMs = Date.parse('2026-06-18T15:37:30Z');
    const verdict = evaluateActivityFreshness([
      { source: 'absolute-text', label: 'Jun 18, 15:37' },
    ], currentNowMs);

    expect(verdict.fresh).toBe(true);
    expect(verdict.evidence).toContain('Jun 18, 15:37');
  });

  it('still fails a genuinely stale feed', () => {
    const verdict = evaluateActivityFreshness([
      { source: 'relative', label: '5h ago' },
      { source: 'absolute-text', label: 'Jun 10, 18:41:53' },
    ], nowMs);

    expect(verdict.fresh).toBe(false);
    expect(verdict.recent).toBe(0);
    expect(verdict.evidence).toContain('none within last 4h');
  });
});
