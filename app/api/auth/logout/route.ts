// SamSpy — POST /api/auth/logout
// Clears the auth cookie.
//
// Version history:
//   v0.1.0 (2026-11-17) — clear cookie.

import { NextResponse } from 'next/server';
import { AUTH_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
