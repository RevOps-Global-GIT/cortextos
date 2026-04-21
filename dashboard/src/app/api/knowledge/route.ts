import { NextRequest } from 'next/server';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { CTX_ROOT, CTX_FRAMEWORK_ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/knowledge?org=<org>  -> { org, content, file_path, exists }
 * PUT  /api/knowledge?org=<org>  body: { org, content } -> same shape
 *
 * Serves the per-org knowledge.md file. File location:
 *   - Prefer CTX_ROOT/orgs/<org>/knowledge.md (the config.ts convention).
 *   - Fall back to CTX_FRAMEWORK_ROOT/orgs/<org>/knowledge.md (where Greg's
 *     revops-global file historically lived under the Git-tracked orgs/ tree).
 *   - On PUT, write to whichever already exists; if neither, create under
 *     CTX_ROOT.
 *
 * Auth: requires Authorization: Bearer <CORTEXTOS_JWT>.
 * CORTEXTOS_JWT must be set in the dashboard .env.local. This is the shared
 * bearer the RGOS `cortextos-knowledge-sync` / `cortextos-knowledge-proxy`
 * edge functions use. No token configured = 503 (fail closed).
 */

const ORG_RE = /^[a-z0-9_-]+$/;

function resolvePath(org: string): { readPath: string; writePath: string; exists: boolean } {
  const ctxRootPath = path.join(CTX_ROOT, 'orgs', org, 'knowledge.md');
  const frameworkPath = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'knowledge.md');

  if (existsSync(ctxRootPath)) {
    return { readPath: ctxRootPath, writePath: ctxRootPath, exists: true };
  }
  if (existsSync(frameworkPath)) {
    return { readPath: frameworkPath, writePath: frameworkPath, exists: true };
  }
  // Neither exists; default new files to CTX_ROOT so future reads follow the
  // primary convention.
  return { readPath: ctxRootPath, writePath: ctxRootPath, exists: false };
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.CORTEXTOS_JWT;
  if (!expected) return false; // fail closed if server isn't configured
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return match[1] === expected;
}

export async function GET(request: NextRequest) {
  if (!process.env.CORTEXTOS_JWT) {
    return Response.json({ error: 'CORTEXTOS_JWT not configured on server' }, { status: 503 });
  }
  if (!authorized(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') ?? '';
  if (!org || !ORG_RE.test(org)) {
    return Response.json({ error: 'org parameter required (a-z0-9_-)' }, { status: 400 });
  }

  const { readPath, exists } = resolvePath(org);
  const content = exists ? readFileSync(readPath, 'utf-8') : '';

  return Response.json({
    org,
    content,
    file_path: readPath,
    exists,
  });
}

export async function PUT(request: NextRequest) {
  if (!process.env.CORTEXTOS_JWT) {
    return Response.json({ error: 'CORTEXTOS_JWT not configured on server' }, { status: 503 });
  }
  if (!authorized(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') ?? '';
  if (!org || !ORG_RE.test(org)) {
    return Response.json({ error: 'org parameter required (a-z0-9_-)' }, { status: 400 });
  }

  let body: { org?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (typeof body.content !== 'string') {
    return Response.json({ error: 'body.content (string) required' }, { status: 400 });
  }
  if (body.org && body.org !== org) {
    return Response.json({ error: 'body.org must match query org' }, { status: 400 });
  }
  if (body.content.length > 2_000_000) {
    return Response.json({ error: 'content too large (>2MB)' }, { status: 413 });
  }

  const { writePath, exists } = resolvePath(org);
  const dir = path.dirname(writePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(writePath, body.content, 'utf-8');

  return Response.json({
    org,
    content: body.content,
    file_path: writePath,
    exists: true,
    was_new: !exists,
  });
}
