// SamSpy — SearchView (tab 2)
// Catalog of saved-search "blocks" (Hookly-style). Each block is one query,
// auto-refreshed daily. Click a block to open its reels. Create any number.
//
// Version history:
//   v0.1.0 (2026-11-17) — block grid, create, open, refresh, delete.
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReelWithCompetitor, SavedSearchCard } from '@/lib/types/db';
import ReelCard from './ReelCard';

export default function SearchView() {
  const [blocks, setBlocks] = useState<SavedSearchCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<SavedSearchCard | null>(null);

  const loadBlocks = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/searches');
    const data = await res.json();
    setBlocks(data.searches ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadBlocks();
  }, [loadBlocks]);

  if (open) {
    return (
      <BlockDetail
        block={open}
        onBack={() => {
          setOpen(null);
          loadBlocks();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <CreateBlock onCreated={loadBlocks} />

      {loading ? (
        <p className="py-10 text-center text-muted">Загрузка…</p>
      ) : blocks.length === 0 ? (
        <p className="py-10 text-center text-muted">
          Пока нет запросов. Создай блок выше — по нему соберутся вирусные Reels,
          и он будет обновляться раз в сутки.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 pb-10 sm:grid-cols-2 lg:grid-cols-3">
          {blocks.map((b) => (
            <BlockCard key={b.id} block={b} onOpen={() => setOpen(b)} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- create ----------------------------------------------------------------
function CreateBlock({ onCreated }: { onCreated: () => void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });
      const data = await res.json();
      if (!res.ok && !data.search) {
        setErr(data.error ?? 'Не удалось создать блок.');
      } else {
        setQuery('');
        onCreated();
      }
    } catch {
      setErr('Ошибка сети.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-gray-900">
        Новый поисковый запрос
      </h2>
      <p className="mb-3 text-xs text-muted">
        Первый поиск — платный запрос (~$0.10). Дальше блок обновляется раз в
        сутки автоматически.
      </p>
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="например, couples questions"
          className="flex-1 rounded-lg border border-edge bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Создаю…' : 'Создать'}
        </button>
      </form>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </div>
  );
}

// --- block card ------------------------------------------------------------
function BlockCard({
  block,
  onOpen,
}: {
  block: SavedSearchCard;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="group relative overflow-hidden rounded-xl border border-edge bg-white text-left shadow-sm transition hover:border-accent/60 hover:shadow-md"
    >
      <div className="relative h-36 w-full overflow-hidden bg-gray-100">
        {block.cover_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={block.cover_url}
            alt={block.label ?? block.query}
            className="h-full w-full object-cover transition group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted">
            нет превью
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 p-3">
          <div className="truncate text-base font-bold text-white">
            {block.label ?? block.query}
          </div>
          <div className="text-xs text-white/80">
            {block.reel_count} Reels
          </div>
        </div>
      </div>
    </button>
  );
}

// --- block detail (reel grid) ----------------------------------------------
function BlockDetail({
  block,
  onBack,
}: {
  block: SavedSearchCard;
  onBack: () => void;
}) {
  const [reels, setReels] = useState<ReelWithCompetitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      const res = await fetch(
        `/api/searches/${block.id}${refresh ? '?refresh=1' : ''}`
      );
      const data = await res.json();
      setReels(data.reels ?? []);
      setLoading(false);
      setRefreshing(false);
    },
    [block.id]
  );

  useEffect(() => {
    load(false);
  }, [load]);

  async function remove() {
    if (!confirm(`Удалить блок «${block.label ?? block.query}»?`)) return;
    await fetch(`/api/searches/${block.id}`, { method: 'DELETE' });
    onBack();
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="text-sm text-muted hover:text-gray-900"
        >
          ← Все запросы
        </button>
        <div className="flex items-center gap-3">
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {refreshing ? 'Обновляю…' : 'Обновить ($0.10)'}
          </button>
          <button
            onClick={remove}
            className="text-sm text-red-600 hover:underline"
          >
            Удалить
          </button>
        </div>
      </div>

      <h2 className="text-lg font-bold text-gray-900">
        {block.label ?? block.query}
      </h2>

      {loading ? (
        <p className="py-10 text-center text-muted">Загрузка…</p>
      ) : reels.length === 0 ? (
        <p className="py-10 text-center text-muted">
          По этому запросу пока ничего не найдено. Нажми «Обновить».
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
