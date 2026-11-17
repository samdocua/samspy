// SamSpy — POST /api/auth/login
// Validates the shared password and sets the auth cookie.
//
// Version history:
//   v0.1.0 (2026-11-17) — password -> auth cookie.

import { NextResponse } from 'next/server';
import {
  AUTH_COOKIE,
  AUTH_MAX_AGE,
  expectedAuthToken,
  passwordMatches,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (!passwordMatches(body.password ?? '')) {
    return NextResponse.json({ error: 'Неверный пароль.' }, { status: 401 });
  }

  const token = await expectedAuthToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: AUTH_MAX_AGE,
  });
  return res;
}
