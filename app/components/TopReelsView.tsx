// SamSpy — TopReelsView (tab 3)
// Shows the cached Instagram 48h top-reels digest; "Обновить" pulls a fresh
// one from Virlo ($0.25). Reuses ReelCard.
//
// Version history:
//   v0.1.0 (2026-11-17) — cached list + manual paid refresh.
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReelWithCompetitor } from '@/lib/types/db';
import ReelCard from './ReelCard';

export default function TopReelsView() {
  const [reels, setReels] = useState<ReelWithCompetitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Free: read cached top reels.
  const loadCached = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/top');
    const data = await res.json();
    setReels(data.reels ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadCached();
  }, [loadCached]);

  // Paid: pull a fresh digest from Virlo ($0.25).
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setErr(null);
    try {
      const res = await fetch('/api/top', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? 'Не удалось обновить.');
      } else {
        setReels(data.reels ?? []);
        setRefreshedAt(data.refreshedAt ?? new Date().toISOString());
      }
    } catch {
      setErr('Ошибка сети.');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-white p-4 shadow-sm">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">
            Топ Reels за 48 часов
          </h2>
          <p className="text-xs text-muted">
            Самые просматриваемые Reels Instagram. Обновление — платный запрос
            ($0.25).
            {refreshedAt &&
              ` Обновлено: ${new Date(refreshedAt).toLocaleString('ru-RU')}`}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {refreshing ? 'Обновляю…' : 'Обновить ($0.25)'}
        </button>
      </div>

      {err && <p className="text-xs text-red-600">{err}</p>}

      {/* grid */}
      {loading ? (
        <p className="py-10 text-center text-muted">Загрузка…</p>
      ) : reels.length === 0 ? (
        <p className="py-10 text-center text-muted">
          Пока пусто. Нажми «Обновить», чтобы загрузить топ Reels за последние
          48 часов.
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
