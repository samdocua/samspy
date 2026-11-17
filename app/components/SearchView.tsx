// SamSpy — SearchView (tab 2)
// Catalog of saved-search "blocks" (Hookly-style). Each block is one query,
// auto-refreshed daily. Click a block to open its reels. Create any number.
//
// Version history:
//   v0.1.0 (2026-11-17) — block grid, create, open, refresh, delete.
//   v0.2.0 (2026-11-17) — manage mode (delete from catalog), per-block
//                         min-views filter, per-block blacklist.
'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  ReelWithCompetitor,
  SavedSearchCard,
  BlacklistEntry,
} from '@/lib/types/db';
import ReelCard from './ReelCard';

const VIEW_OPTIONS = [
  { label: 'Любые просмотры', value: 0 },
  { label: '10K+', value: 10000 },
  { label: '100K+', value: 100000 },
  { label: '1M+', value: 1000000 },
];

export default function SearchView() {
  const [blocks, setBlocks] = useState<SavedSearchCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<SavedSearchCard | null>(null);
  const [manage, setManage] = useState(false);

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

  async function deleteBlock(id: string, name: string) {
    if (!confirm(`Удалить блок «${name}»?`)) return;
    await fetch(`/api/searches/${id}`, { method: 'DELETE' });
    loadBlocks();
  }

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

      {blocks.length > 0 && (
        <div className="flex justify-end">
          <button
            onClick={() => setManage((m) => !m)}
            className="text-sm text-muted hover:text-gray-900"
          >
            {manage ? 'Готово' : 'Управление'}
          </button>
        </div>
      )}

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
            <BlockCard
              key={b.id}
              block={b}
              manage={manage}
              onOpen={() => setOpen(b)}
              onDelete={() => deleteBlock(b.id, b.label ?? b.query)}
            />
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
  manage,
  onOpen,
  onDelete,
}: {
  block: SavedSearchCard;
  manage: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-edge bg-white shadow-sm transition hover:border-accent/60 hover:shadow-md">
      {manage && (
        <button
          onClick={onDelete}
          title="Удалить блок"
          className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-red-600 text-sm text-white"
        >
          ✕
        </button>
      )}
      <button onClick={onOpen} className="block w-full text-left">
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
            <div className="text-xs text-white/80">{block.reel_count} Reels</div>
          </div>
        </div>
      </button>
    </div>
  );
}

// --- block detail (reel grid + settings) -----------------------------------
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
  const [minViews, setMinViews] = useState(block.min_views ?? 0);
  const [showBlacklist, setShowBlacklist] = useState(false);

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

  // Persist the min-views filter, then reload.
  async function changeMinViews(v: number) {
    setMinViews(v);
    await fetch(`/api/searches/${block.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ min_views: v }),
    });
    load(false);
  }

  // Hide an author from this block (blacklist by @username), then reload.
  async function hideAuthor(reel: ReelWithCompetitor) {
    const handle = reel.author_username;
    if (!handle) return;
    if (!confirm(`Скрыть @${handle} из этого блока?`)) return;
    await fetch(`/api/searches/${block.id}/blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: handle }),
    });
    load(false);
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button onClick={onBack} className="text-sm text-muted hover:text-gray-900">
          ← Все запросы
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={minViews}
            onChange={(e) => changeMinViews(Number(e.target.value))}
            className="rounded-lg border border-edge bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-accent"
          >
            {VIEW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowBlacklist((s) => !s)}
            className="text-sm text-muted hover:text-gray-900"
          >
            Чёрный список
          </button>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {refreshing ? 'Обновляю…' : 'Обновить ($0.10)'}
          </button>
        </div>
      </div>

      <h2 className="text-lg font-bold text-gray-900">
        {block.label ?? block.query}
      </h2>

      {showBlacklist && (
        <SearchBlacklist blockId={block.id} onChange={() => load(false)} />
      )}

      {loading ? (
        <p className="py-10 text-center text-muted">Загрузка…</p>
      ) : reels.length === 0 ? (
        <p className="py-10 text-center text-muted">
          Ничего не найдено под текущим фильтром. Снизь «минимум просмотров» или
          нажми «Обновить».
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

// --- per-block blacklist manager -------------------------------------------
function SearchBlacklist({
  blockId,
  onChange,
}: {
  blockId: string;
  onChange: () => void;
}) {
  const [list, setList] = useState<BlacklistEntry[]>([]);
  const [value, setValue] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/searches/${blockId}/blacklist`);
    const data = await res.json();
    setList(data.blacklist ?? []);
  }, [blockId]);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    await fetch(`/api/searches/${blockId}/blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: value.trim() }),
    });
    setValue('');
    load();
    onChange();
  }

  async function remove(id: string) {
    await fetch(`/api/searches/${blockId}/blacklist?id=${id}`, {
      method: 'DELETE',
    });
    load();
    onChange();
  }

  return (
    <div className="rounded-xl border border-edge bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">
        Чёрный список блока
      </h3>
      <form onSubmit={add} className="mb-3 flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="@аккаунт для скрытия"
          className="flex-1 rounded-lg border border-edge bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-accent"
        />
        <button
          type="submit"
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
        >
          Скрыть
        </button>
      </form>
      {list.length === 0 ? (
        <p className="text-xs text-muted">Список пуст.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {list.map((e) => (
            <span
              key={e.id}
              className="flex items-center gap-1.5 rounded-full border border-edge px-2.5 py-1 text-xs text-gray-700"
            >
              {e.label ?? `@${e.username}`}
              <button
                onClick={() => remove(e.id)}
                className="text-muted hover:text-red-600"
                title="Убрать из списка"
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
