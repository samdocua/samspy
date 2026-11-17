// SamSpy — AddCompetitor (v0.1.0, 2026-11-17)
// Input to add a competitor by @username or IG URL. Calls POST /api/competitors.
'use client';

import { useState } from 'react';

export default function AddCompetitor({
  onAdded,
}: {
  onAdded?: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch('/api/competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? 'Failed to add.');
      } else {
        setMsg(data.message ?? 'Added.');
        setValue('');
        onAdded?.();
      }
    } catch {
      setErr('Network error.');
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
          {busy ? 'Adding…' : 'Track'}
        </button>
      </div>
      {msg && <p className="text-xs text-emerald-600">{msg}</p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </form>
  );
}
