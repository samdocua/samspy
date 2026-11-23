// SamSpy — background worker auth (server only)
//
// Long jobs («Анализ», «Карусели», «План») advance in ~40 s steps. Before, only an open tab
// called the step endpoints. Now Supabase does it too: pg_cron runs public.samspy_tick() every
// 20 s, and that function sends (pg_net) one POST /api/cron/step?kind=…&id=… per unfinished,
// unlocked job. The tab still calls steps while open (faster, shows progress); the job lock
// keeps the two from working on the same job at once.
//
// The tick authenticates with the x-worker-secret header. The secret lives only in the
// database (table worker_config, RLS on, no policies → service role only), so nothing has to be
// copied into Vercel env: the route reads it with the service client and compares.
//
// Version history:
//   v0.1.0 (2026-11-23) — initial.

import type { SupabaseClient } from '@supabase/supabase-js';
import { safeEqual } from '@/lib/auth';

let cached: { value: string; at: number } | null = null;
const CACHE_MS = 5 * 60_000;

async function workerSecret(sb: SupabaseClient): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const { data } = await sb.from('worker_config').select('value').eq('key', 'secret').maybeSingle<{ value: string }>();
  if (!data?.value) return null;
  cached = { value: data.value, at: Date.now() };
  return data.value;
}

export async function workerAuthorized(sb: SupabaseClient, req: Request): Promise<boolean> {
  const got = req.headers.get('x-worker-secret');
  if (!got) return false;
  const want = await workerSecret(sb);
  if (!want) return false;
  try {
    return safeEqual(got, want);
  } catch {
    return false;
  }
}
