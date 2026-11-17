// SamSpy — CompetitorsView (v0.1.0, 2026-11-17)
// Tab 1 client view: add accounts, filter, and show the reel grid.
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReelWithCompetitor, Competitor } from '@/lib/types/db';
import ReelCard from './ReelCard';
import AddCompetitor from './AddCompetitor';
import FiltersBar, { type Filters } from './FiltersBar';

export default function CompetitorsView() {
  const [reels, setReels] = useState<ReelWithCompetitor[]>([]);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [loading, setLoading] = useState(true);
  // Start at 0 so reels show even before an outlier ratio is computed
  // (IG views can be 0 on the first sync). Raise the slider to filter.
  const [filters, setFilters] = useState<Filters>({
    period: null,
    minOutlier: 0,
    minViews: 0,
    sort: 'outlier',
  });

  const loadReels = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      source: 'competitor',
      min_outlier: String(filters.minOutlier),
      min_views: String(filters.minViews),
      sort: filters.sort,
    });
    if (filters.period) params.set('period', String(filters.period));
    const res = await fetch(`/api/reels?${params.toString()}`);
    const data = await res.json();
    setReels(data.reels ?? []);
    setLoading(false);
  }, [filters]);

  const loadCompetitors = useCallback(async () => {
    const res = await fetch('/api/competitors');
    const data = await res.json();
    setCompetitors(data.competitors ?? []);
  }, []);

  useEffect(() => {
    loadReels();
  }, [loadReels]);
  useEffect(() => {
    loadCompetitors();
  }, [loadCompetitors]);

  return (
    <div className="flex flex-col gap-5">
      {/* header: add account + tracked count */}
      <div className="rounded-xl border border-edge bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted">
            Tracked accounts ({competitors.length})
          </h2>
        </div>
        <AddCompetitor onAdded={loadCompetitors} />
        {competitors.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {competitors.map((c) => (
              <span
                key={c.id}
                className="rounded-full border border-edge px-2.5 py-1 text-xs text-muted"
                title={c.virlo_status}
              >
                @{c.username}
                <span
                  className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                    c.virlo_status === 'active'
                      ? 'bg-emerald-400'
                      : c.virlo_status === 'pending'
                        ? 'bg-amber-400'
                        : 'bg-red-400'
                  }`}
                />
              </span>
            ))}
          </div>
        )}
      </div>

      {/* filters */}
      <FiltersBar filters={filters} onChange={setFilters} />

      {/* grid */}
      {loading ? (
        <p className="py-10 text-center text-muted">Loading…</p>
      ) : reels.length === 0 ? (
        <p className="py-10 text-center text-muted">
          No reels yet. Add accounts above — reels appear after the first daily
          sync (each account enriches in ~1–2 min).
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 pb-10 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {reels.map((r) => (
            <ReelCard key={r.id} reel={r} />
          ))}
        </div>
      )}
    </div>
  );
}
