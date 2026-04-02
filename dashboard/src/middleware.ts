// cortextOS Dashboard - Auth middleware
// Checks for next-auth session cookie; redirects to /login if missing.
// Cannot import auth.ts directly because it chains to better-sqlite3,
// which is not available in the Edge Runtime.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

// Allowed CORS origins — localhost dev + configured deployment URL + mobile app
function getAllowedOrigin(requestOrigin: string | null): string | null {
  const allowed = [
    'http://localhost:3000',
    'http://localhost:3001',
    process.env.NEXTAUTH_URL,
    process.env.DASHBOARD_URL,
    process.env.MOBILE_APP_ORIGIN,
  ].filter(Boolean) as string[];
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return null;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestOrigin = request.headers.get('origin');
  const corsOrigin = getAllowedOrigin(requestOrigin) ?? 'null';

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
      },
    });
  }

  // Allow public paths
  // Security (H7): SSE endpoints require ?token=<jwt> auth — removed from public whitelist
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico'
  ) {
    const response = NextResponse.next();
    response.headers.set('Access-Control-Allow-Origin', corsOrigin);
    response.headers.set('Vary', 'Origin');
    return response;
  }

  // Check for next-auth session token cookie (web dashboard)
  const hasSession =
    request.cookies.has('authjs.session-token') ||
    request.cookies.has('__Secure-authjs.session-token');

  // Check for Bearer token (mobile app)
  const authHeader = request.headers.get('Authorization');
  let hasBearerToken = false;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token.length > 0) {
      try {
        // Security (H6): Verify JWT signature — presence-only check bypassed by any string.
        const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
        if (authSecret) {
          const secret = new TextEncoder().encode(authSecret);
          await jwtVerify(token, secret);
          hasBearerToken = true;
        }
      } catch {
        hasBearerToken = false;
      }
    }
  }

  if (!hasSession && !hasBearerToken) {
    // For API routes, return 401 instead of redirect
    if (pathname.startsWith('/api/')) {
      const res = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      res.headers.set('Access-Control-Allow-Origin', corsOrigin);
      res.headers.set('Vary', 'Origin');
      return res;
    }
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next();
  response.headers.set('Access-Control-Allow-Origin', corsOrigin);
  response.headers.set('Vary', 'Origin');
  // Standard security headers
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
