import { describe, it, expect } from 'vitest';
import { detectStaleness } from '../scripts/page-health-staleness';

// Real fleet/tasks body content captured from a live page-health run: a tasks board
// listing tasks with "2 days ago" relative ages. This previously tripped a permanent
// false staleness warning, blocking the surface from ever going green.
const FLEET_TASKS_BODY =
  'theta Proposal 5: graceful partial finalization high Assigned: analyst 2 days ago ' +
  'Weekly brain digest — 2026-06-01 to 2026-06-08 medium Assigned: analyst 2 days ago ' +
  'Unstick auto-merge queue: clear memo-conflict false-positive in_progress 5 days ago';

describe('page-health staleness detection', () => {
  // ---- BLOCK direction: a real staleness signal MUST still flag ----
  describe('flags genuine staleness (masking guard)', () => {
    it('flags an explicit "Nd stale" badge in body text', () => {
      const r = detectStaleness([], 'Data Sources Live — cortextOS 6d stale 8 active');
      expect(r.stale).toBe(true);
      expect(r.detail).toMatch(/6d stale/i);
    });

    it('flags an "Nh stale" badge in body text', () => {
      expect(detectStaleness([], 'connector 36h stale').stale).toBe(true);
    });

    it('flags a "Stale" status chip', () => {
      expect(detectStaleness(['Stale'], FLEET_TASKS_BODY).stale).toBe(true);
    });

    it('flags a "Stale heartbeat" aria-label', () => {
      expect(detectStaleness(['Stale heartbeat'], '').stale).toBe(true);
    });

    it('flags a "Stale agents (no heartbeat 30m+)" status label', () => {
      expect(detectStaleness(['Stale agents (no heartbeat 30m+)'], '').stale).toBe(true);
    });

    it('flags a "Last synced 6 days ago" sync banner', () => {
      const r = detectStaleness(['Last synced 6 days ago'], '');
      expect(r.stale).toBe(true);
    });

    it('flags an "out of date" status banner', () => {
      expect(detectStaleness(['Source out of date'], '').stale).toBe(true);
    });

    it('flags a "Never synced" connector label', () => {
      expect(detectStaleness(['Never synced'], '').stale).toBe(true);
    });
  });

  // ---- PASS direction: listed content must NOT flag ----
  describe('does not flag listed content (false-positive guard)', () => {
    it('does NOT flag a tasks board listing "2 days ago" task ages', () => {
      expect(detectStaleness([], FLEET_TASKS_BODY).stale).toBe(false);
    });

    it('does NOT flag a task TITLE containing the word "stale" (long, not a status chip)', () => {
      const longTitle = 'Auto-recover stale in_progress tasks abandoned by dead agents';
      expect(detectStaleness([longTitle], FLEET_TASKS_BODY).stale).toBe(false);
    });

    it('does NOT flag a short content label with a bare relative timestamp (no sync context)', () => {
      expect(detectStaleness(['Created 3 days ago by analyst'], '').stale).toBe(false);
    });

    it('does NOT flag "N days ago" appearing only in body text', () => {
      expect(detectStaleness([], 'updated 4 days ago in the activity feed').stale).toBe(false);
    });

    it('does NOT flag a clean page with no status labels', () => {
      expect(detectStaleness([], 'Companies Acme acme.com 120 contacts').stale).toBe(false);
    });
  });
});
