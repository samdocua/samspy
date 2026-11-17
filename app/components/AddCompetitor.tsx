// SamSpy — AddCompetitor
//   v0.1.0 (2026-11-17) — add by @username / IG URL.
//   v0.2.0 (2026-11-17) — after adding, poll a per-account sync so reels start
//                         collecting immediately (Virlo needs ~1–2 min to
//                         enrich, so we poll until reels appear).
'use client';

import { useState } from 'react';

import type { Platform } from '@/lib/types/db';

export default function AddCompetitor({
  platform,
  onAdded,
  onSynced,
}: {
  platform: Platform;
  onAdded?: () => void;              // reload the tracked-accounts chips
  onSynced?: () => void;            // reload the reel grid when reels arrive
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Poll the per-competitor sync until reels appear (or we give up ~2 min).
  async function collect(id: string) {
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`/api/competitors/${id}/sync`, {
          method: 'POST',
        });
        const data = await res.json();
        if (data.result?.reelsUpserted > 0) {
          onSynced?.();
          return true;
        }
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, 6000));
    }
    return false;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    setErr(null);
    try {
      const res = await fetch('/api/competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: value.trim(), platform }),
      });
      const data = await res.json();
      if (!res.ok && !data.competitor) {
        setErr(data.error ?? 'Не удалось добавить.');
        return;
      }
      setValue('');
      onAdded?.();

      // Start collecting reels right away.
      if (data.competitor?.id) {
        setStatus('Собираем ролики… (до ~2 минут)');
        const ok = await collect(data.competitor.id);
        setStatus(
          ok
            ? 'Сбор роликов завершён.'
            : 'Аккаунт добавлен. Ролики появятся при следующем обновлении.'
        );
      }
    } catch {
      setErr('Ошибка сети.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="@username or instagram.com/username"
          className="flex-1 rounded-lg border border-edge bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Добавляю…' : 'Track'}
        </button>
      </div>
      {status && <p className="text-xs text-emerald-600">{status}</p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </form>
  );
}
