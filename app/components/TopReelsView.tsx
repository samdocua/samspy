// SamSpy — TopReelsView (tab 3)
// Shows the cached Instagram 48h top-reels digest; "Обновить" pulls a fresh
// one from Virlo ($0.25). Reuses ReelCard.
//
// Version history:
//   v0.1.0 (2026-11-17) — cached list + manual paid refresh.
//   v0.2.0 (2026-11-17) — per-card hide author (Top Reels blacklist).
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReelWithCompetitor, BlacklistEntry } from '@/lib/types/db';
import ReelCard from './ReelCard';

export default function TopReelsView() {
  const [reels, setReels] = useState<ReelWithCompetitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showBlacklist, setShowBlacklist] = useState(false);

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

  // Hide an author from Top Reels (blacklist by author id).
  async function hideAuthor(reel: ReelWithCompetitor) {
    const authorId = reel.author_external_id;
    if (!authorId) {
      alert('У этого ролика нет id автора — скрыть нельзя.');
      return;
    }
    if (!confirm('Скрыть этого автора из топа?')) return;
    await fetch('/api/top/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author_external_id: authorId,
        label: reel.caption?.slice(0, 40) || authorId,
      }),
    });
    loadCached();
  }

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
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowBlacklist((s) => !s)}
            className="text-sm text-muted hover:text-gray-900"
          >
            Чёрный список
          </button>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {refreshing ? 'Обновляю…' : 'Обновить ($0.25)'}
          </button>
        </div>
      </div>

      {showBlacklist && <TopBlacklist onChange={loadCached} />}

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
            <ReelCard key={r.id} reel={r} onHide={hideAuthor} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Top Reels blacklist manager (remove entries) --------------------------
function TopBlacklist({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<BlacklistEntry[]>([]);

  const load = useCallback(async () => {
    const res = await fetch('/api/top/blacklist');
    const data = await res.json();
    setList(data.blacklist ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(id: string) {
    await fetch(`/api/top/blacklist?id=${id}`, { method: 'DELETE' });
    load();
    onChange();
  }

  return (
    <div className="rounded-xl border border-edge bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">
        Скрытые авторы топа
      </h3>
      <p className="mb-3 text-xs text-muted">
        Чтобы скрыть автора — наведи на ролик и нажми ✕. Здесь можно вернуть
        скрытых.
      </p>
      {list.length === 0 ? (
        <p className="text-xs text-muted">Список пуст.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {list.map((e) => (
            <span
              key={e.id}
              className="flex items-center gap-1.5 rounded-full border border-edge px-2.5 py-1 text-xs text-gray-700"
            >
              {e.label ?? e.author_external_id}
              <button
                onClick={() => remove(e.id)}
                className="text-muted hover:text-red-600"
                title="Вернуть автора"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
