// SamSpy — login page
// Single password field. On success, the cookie is set and we go to home.
//
// Version history:
//   v0.1.0 (2026-11-17) — password login form.
'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Full navigation so middleware re-reads the fresh cookie.
        window.location.href = '/';
      } else {
        const data = await res.json().catch(() => ({}));
        setErr(data.error ?? 'Неверный пароль.');
      }
    } catch {
      setErr('Ошибка сети.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-edge bg-white p-6 shadow-sm"
      >
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-bold text-white">
            S
          </div>
          <h1 className="text-lg font-bold text-gray-900">SamSpy</h1>
        </div>

        <label className="mb-1 block text-sm text-muted">Пароль</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="mb-3 w-full rounded-lg border border-edge bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-accent"
        />

        {err && <p className="mb-3 text-xs text-red-600">{err}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Вход…' : 'Войти'}
        </button>
      </form>
    </main>
  );
}
