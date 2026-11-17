// SamSpy — CompetitorsView
//   v0.1.0 (2026-11-17) — add accounts, filter, reel grid.
//   v0.2.0 (2026-11-17) — clickable account chips to filter the grid by one
//                         account, higher grid limit, auto-collect on add.
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReelWithCompetitor, Competitor, Platform } from '@/lib/types/db';
import ReelCard from './ReelCard';
import AddCompetitor from './AddCompetitor';
import FiltersBar, { type Filters } from './FiltersBar';

const PAGE = 60;

export default function CompetitorsView({ platform }: { platform: Platform }) {
  const [reels, setReels] = useState<ReelWithCompetitor[]>([]);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // null = all accounts; otherwise filter the grid to this competitor id.
  const [selected, setSelected] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  // Start at 0 so reels show even before an outlier ratio is computed
  // (IG views can be 0 on the first sync). Raise the slider to filter.
  const [filters, setFilters] = useState<Filters>({
    period: null,
    minOutlier: 0,
    minViews: 0,
    sort: 'outlier',
  });

  const buildParams = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({
        source: 'competitor',
        platform,
        min_outlier: String(filters.minOutlier),
        min_views: String(filters.minViews),
        sort: filters.sort,
        limit: String(PAGE),
        offset: String(offset),
      });
      if (filters.period) params.set('period', String(filters.period));
      if (selected) params.set('competitor_id', selected);
      return params;
    },
    [filters, selected, platform]
  );

  // Load the first page (replaces the grid).
  const loadReels = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/reels?${buildParams(0).toString()}`);
    const data = await res.json();
    setReels(data.reels ?? []);
    setHasMore(!!data.hasMore);
    setLoading(false);
  }, [buildParams]);

  // Append the next page.
  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    const res = await fetch(`/api/reels?${buildParams(reels.length).toString()}`);
    const data = await res.json();
    setReels((prev) => [...prev, ...(data.reels ?? [])]);
    setHasMore(!!data.hasMore);
    setLoadingMore(false);
  }

  const loadCompetitors = useCallback(async () => {
    const res = await fetch(`/api/competitors?platform=${platform}`);
    const data = await res.json();
    setCompetitors(data.competitors ?? []);
  }, [platform]);

  async function deleteCompetitor(c: Competitor) {
    if (!confirm(`Перестать отслеживать @${c.username} и удалить его ролики?`))
      return;
    await fetch(`/api/competitors/${c.id}`, { method: 'DELETE' });
    if (selected === c.id) setSelected(null);
    loadCompetitors();
    loadReels();
  }

  useEffect(() => {
    loadReels();
  }, [loadReels]);
  useEffect(() => {
    loadCompetitors();
  }, [loadCompetitors]);

  return (
    <div className="flex flex-col gap-5">
      {/* header: add account + tracked chips */}
      <div className="rounded-xl border border-edge bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted">
            Отслеживаемые аккаунты ({competitors.length})
          </h2>
          <div className="flex items-center gap-3">
            {selected && (
              <button
                onClick={() => setSelected(null)}
                className="text-xs text-accent hover:underline"
              >
                Показать все
              </button>
            )}
            {competitors.length > 0 && (
              <button
                onClick={() => setManage((m) => !m)}
                className="text-xs text-muted hover:text-gray-900"
              >
                {manage ? 'Готово' : 'Управление'}
              </button>
            )}
          </div>
        </div>
        <AddCompetitor
          platform={platform}
          onAdded={loadCompetitors}
          onSynced={loadReels}
        />
        {competitors.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {competitors.map((c) => {
              const active = selected === c.id;
              return (
                <span
                  key={c.id}
                  className={`flex items-center rounded-full border px-2.5 py-1 text-xs transition ${
                    active
                      ? 'border-accent bg-accent/10 text-gray-900'
                      : 'border-edge text-muted'
                  }`}
                  title={c.virlo_status}
                >
                  <button
                    onClick={() => setSelected(active ? null : c.id)}
                    className="hover:text-gray-900"
                  >
                    @{c.username}
                  </button>
                  <span
                    className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                      c.virlo_status === 'active'
                        ? 'bg-emerald-400'
                        : c.virlo_status === 'pending'
                          ? 'bg-amber-400'
                          : 'bg-red-400'
                    }`}
                  />
                  {manage && (
                    <button
                      onClick={() => deleteCompetitor(c)}
                      title="Перестать отслеживать"
                      className="ml-1.5 text-red-600 hover:text-red-700"
                    >
                      ✕
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* filters */}
      <FiltersBar filters={filters} onChange={setFilters} />

      {/* grid */}
      {loading ? (
        <p className="py-10 text-center text-muted">Загрузка…</p>
      ) : reels.length === 0 ? (
        <p className="py-10 text-center text-muted">
          Пока нет роликов. Добавь аккаунты выше — после добавления ролики
          собираются автоматически (аккаунт обрабатывается ~1–2 минуты).
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {reels.map((r) => (
              <ReelCard key={r.id} reel={r} />
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center pb-10 pt-5">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="rounded-lg border border-edge bg-white px-6 py-2 text-sm font-semibold text-gray-900 shadow-sm hover:border-accent disabled:opacity-50"
              >
                {loadingMore ? 'Загрузка…' : 'Показать ещё'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
