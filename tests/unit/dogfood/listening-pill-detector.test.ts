import { describe, expect, it } from 'vitest';
import {
  findDuplicateListeningPills,
  isListeningPillCandidate,
  type ListeningPillCandidate,
} from '../../../src/dogfood/listening-pill-detector';

const pageKey = 'cottage';

function candidate(partial: Partial<ListeningPillCandidate>): ListeningPillCandidate {
  return { pageKey, tagName: 'button', ...partial };
}

describe('listening pill duplicate detector', () => {
  it('does not flag ordinary glass-pill tabs that do not represent Listening state', () => {
    const candidates = [
      candidate({ text: 'Cottage', className: 'glass-pill tab-pill' }),
      candidate({ text: 'Maintenance', className: 'glass-pill tab-pill' }),
      candidate({ text: 'Settings', className: 'glass-pill tab-pill' }),
    ];

    expect(candidates.some(isListeningPillCandidate)).toBe(false);
    expect(findDuplicateListeningPills(candidates)).toEqual([]);
  });

  it('does not flag a single legitimate Listening status pill', () => {
    const candidates = [
      candidate({ ariaLabel: 'Listening', text: 'Listening', className: 'status-pill' }),
      candidate({ text: 'History', className: 'glass-pill tab-pill' }),
    ];

    expect(findDuplicateListeningPills(candidates)).toEqual([]);
  });

  it('flags duplicate .listening-pill instances with the same label on the same page', () => {
    const candidates = [
      candidate({ ariaLabel: 'Listening', className: 'listening-pill' }),
      candidate({ ariaLabel: 'Listening', className: 'listening-pill' }),
    ];

    const duplicates = findDuplicateListeningPills(candidates);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ pageKey, count: 2 });
  });

  it('flags duplicate aria-labelled Listening pills only when the class is pill-like', () => {
    const candidates = [
      candidate({ ariaLabel: 'Listening', className: 'status-pill active' }),
      candidate({ ariaLabel: 'Listening', className: 'status-pill active' }),
      candidate({ ariaLabel: 'Listening', className: 'metric-card' }),
    ];

    const duplicates = findDuplicateListeningPills(candidates);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].candidates).toHaveLength(2);
  });

  it('does not merge similar Listening pills across different pages or labels', () => {
    const candidates = [
      candidate({ pageKey: 'cottage', ariaLabel: 'Listening', className: 'status-pill' }),
      candidate({ pageKey: 'settings', ariaLabel: 'Listening', className: 'status-pill' }),
      candidate({ pageKey: 'cottage', ariaLabel: 'Listening history', className: 'status-pill' }),
    ];

    expect(findDuplicateListeningPills(candidates)).toEqual([]);
  });
});
