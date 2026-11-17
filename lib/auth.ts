// SamSpy — auth token helpers (edge + node compatible)
//
// A single shared password gates the whole app. We never store the password
// in the cookie; instead the cookie holds an HMAC token derived from
// SAMSPY_SECRET. Login checks the password once, then sets this token.
// Middleware recomputes the same token and compares.
//
// Uses Web Crypto (global `crypto.subtle`), available in both the Edge
// middleware runtime and Node route handlers.
//
// Version history:
//   v0.1.0 (2026-11-17) — HMAC-based auth cookie.

export const AUTH_COOKIE = 'samspy_auth';
export const AUTH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days (seconds)

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The expected cookie value: HMAC-SHA256(SAMSPY_SECRET, "samspy-auth-v1").
 * Deterministic, so login and middleware produce the same token.
 */
export async function expectedAuthToken(): Promise<string> {
  const secret = process.env.SAMSPY_SECRET;
  if (!secret) throw new Error('SAMSPY_SECRET is not set.');

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('samspy-auth-v1'));
  return toHex(sig);
}

/** Constant-time-ish compare (length + char compare) to avoid trivial leaks. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the password matches SAMSPY_PASSWORD. */
export function passwordMatches(input: string): boolean {
  const pw = process.env.SAMSPY_PASSWORD;
  if (!pw) return false;
  return safeEqual(input, pw);
}
