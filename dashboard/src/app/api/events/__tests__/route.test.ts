/**
 * Regression test for events API per-row JSON.parse isolation.
 *
 * Before PR #15 fix: a single malformed `data` column value caused the entire
 * /api/events response to 500. After the fix, corrupted rows return null for
 * `data` and the rest of the response succeeds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock db before importing the route so the route picks up the mock.
vi.mock('@/lib/db', () => ({
  db: {
    prepare: vi.fn(),
  },
}));

import { db } from '@/lib/db';
import { GET } from '../route';

// Minimal row shape matching what the DB returns.
function makeRow(id: string, data: string | null, message = 'msg') {
  return {
    id,
    timestamp: `2026-01-0${id}T00:00:00Z`,
    agent: 'dev',
    org: 'test',
    type: 'action',
    category: null,
    severity: 'info',
    data,
    message,
    source_file: null,
  };
}

function mockDb(rows: ReturnType<typeof makeRow>[]) {
  vi.mocked(db.prepare).mockReturnValue({
    all: vi.fn().mockReturnValue(rows),
  } as unknown as ReturnType<typeof db.prepare>);
}

describe('GET /api/events — per-row JSON.parse isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 when one row has corrupted JSON; that row gets null data', async () => {
    mockDb([
      makeRow('1', '{"key":"value"}'),
      makeRow('2', '{BAD JSON}', 'corrupted'),
      makeRow('3', '{"other":"data"}'),
    ]);

    const req = new NextRequest('http://localhost/api/events');
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(3);
    expect(body[0].data).toEqual({ key: 'value' });
    expect(body[1].data).toBeNull();   // corrupted → null, NOT a 500
    expect(body[2].data).toEqual({ other: 'data' });
  });

  it('returns 200 with all-null data when every row has corrupted JSON', async () => {
    mockDb([
      makeRow('1', 'NOT_JSON'),
      makeRow('2', '}}broken{{'),
    ]);

    const req = new NextRequest('http://localhost/api/events');
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].data).toBeNull();
    expect(body[1].data).toBeNull();
  });

  it('returns 200 with null data for null data column rows', async () => {
    mockDb([
      makeRow('1', null),
      makeRow('2', '{"ok":true}'),
    ]);

    const req = new NextRequest('http://localhost/api/events');
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].data).toBeNull();
    expect(body[1].data).toEqual({ ok: true });
  });
});
