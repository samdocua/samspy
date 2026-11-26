// SamSpy — auth middleware
//
// Gates the whole app behind the shared password. Runs on every request
// except static assets. Unauthenticated page requests are redirected to
// /login; unauthenticated API requests get 401.
//
// Exceptions (always allowed):
//   /login           — the login page
//   /api/auth/*      — login/logout endpoints
//   /api/cron/*      — cron / background worker, each checks its own secret, no cookie
//   /s/*, /api/s/*   — slides sent «На телефон»: the unguessable token in the link is the key
//
// Version history:
//   v0.1.0 (2026-11-17) — cookie check + redirect/401.
//   v0.1.1 (2026-11-23) — /api/cron/step (background worker) noted.
//   v0.2.0 (2026-11-26) — /s/<token> phone page of shared slides is public.

import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE, expectedAuthToken, safeEqual } from '@/lib/auth';

const PUBLIC_PATHS = ['/login', '/api/auth', '/api/cron', '/s', '/api/s'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths through.
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  let ok = false;
  if (cookie) {
    try {
      ok = safeEqual(cookie, await expectedAuthToken());
    } catch {
      ok = false;
    }
  }

  if (ok) return NextResponse.next();

  // API: respond 401 instead of redirecting.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // Pages: redirect to login.
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  return NextResponse.redirect(url);
}

// Run on everything except Next internals and static files.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
