import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

// Security (CORS-001) regression: the previous implementation set
// `Access-Control-Allow-Origin: null` (literal string) for any non-allowlisted
// origin. `null` is a value browsers honor for null-origin contexts (sandboxed
// iframes, data: URLs), so it must NEVER be emitted. The fix omits the ACAO
// header entirely unless the request origin is in the allowlist.
//
// We exercise the CORS preflight (OPTIONS) branch because it runs before any
// auth-secret / session logic and so needs no auth mocking.

function preflight(origin: string | null): Promise<Response> {
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);
  const req = new NextRequest('http://localhost:3000/api/approvals', {
    method: 'OPTIONS',
    headers,
  });
  return middleware(req) as unknown as Promise<Response>;
}

describe('middleware CORS-001 hardening (ACAO fallback)', () => {
  it('does NOT emit an ACAO header for a disallowed origin', async () => {
    const res = await preflight('https://evil.example.com');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('never emits the literal string "null" as ACAO', async () => {
    const res = await preflight('https://evil.example.com');
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('null');
  });

  it('does NOT emit an ACAO header when no origin is present', async () => {
    const res = await preflight(null);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('reflects an allowlisted origin in ACAO', async () => {
    const res = await preflight('http://localhost:3000');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
  });

  it('always sets Vary: Origin on preflight responses', async () => {
    const res = await preflight('https://evil.example.com');
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});
