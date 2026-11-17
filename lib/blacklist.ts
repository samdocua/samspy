// SamSpy — blacklist helpers
//
// Per-search-block blacklist (by @username) and a separate Top-Reels
// blacklist (by author_external_id, since the digest has no @username).
//
// Version history:
//   v0.2.0 (2026-11-17) — lookups used by the refreshers + API routes.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Lowercased usernames blacklisted for one search block. */
export async function searchBlacklistUsernames(
  supabase: SupabaseClient,
  savedSearchId: string
): Promise<Set<string>> {
  const { data } = await supabase
    .from('blacklist')
    .select('username')
    .eq('scope', 'search')
    .eq('saved_search_id', savedSearchId);
  return new Set(
    (data ?? [])
      .map((r) => (r.username ?? '').toLowerCase())
      .filter(Boolean)
  );
}

/** Author external ids blacklisted for Top Reels. */
export async function topBlacklistAuthorIds(
  supabase: SupabaseClient
): Promise<Set<string>> {
  const { data } = await supabase
    .from('blacklist')
    .select('author_external_id')
    .eq('scope', 'top');
  return new Set(
    (data ?? []).map((r) => r.author_external_id).filter(Boolean) as string[]
  );
}
