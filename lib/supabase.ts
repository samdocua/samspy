// SamSpy — Supabase clients
//
// Version history:
//   v0.1.0 (2026-11-17) — Browser (anon) + server (service-role) clients.
//
// The service-role client bypasses Row Level Security and must NEVER be
// imported into client components. It's only used in API routes / cron.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Browser/anon client. Safe to use in client components for reads.
 * (We keep tables without RLS; writes always go through server routes.)
 */
export function createBrowserClient(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error('Supabase URL / anon key not set in environment.');
  }
  return createClient(url, anonKey);
}

/**
 * Server-only client with the service-role key. Full access, no RLS.
 * Use only inside API routes, server components, and cron handlers.
 */
export function createServiceClient(): SupabaseClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Supabase URL / service-role key not set in environment.');
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
