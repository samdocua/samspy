// SamSpy — home page with the three tabs
//   v0.1.0 (2026-11-17) — tabs; competitors + top live.
//   v0.1.1 (2026-11-17) — logout button (auth).
'use client';

import { useState } from 'react';
import CompetitorsView from './components/CompetitorsView';
import TopReelsView from './components/TopReelsView';

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

type Tab = 'competitors' | 'search' | 'top';

const TABS: { id: Tab; label: string }[] = [
  { id: 'competitors', label: 'По конкурентам' },
  { id: 'search', label: 'По поисковым запросам' },
  { id: 'top', label: 'Топ Reels' },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>('competitors');

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      {/* brand + logout */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-bold text-white">
            S
          </div>
          <h1 className="text-lg font-bold">SamSpy</h1>
        </div>
        <button
          onClick={logout}
          className="text-xs text-muted hover:text-gray-900"
        >
          Выйти
        </button>
      </div>

      {/* tabs */}
      <div className="mb-6 flex gap-1 border-b border-edge">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`border-b-2 px-4 py-2 text-sm transition ${
              tab === t.id
                ? 'border-accent text-gray-900 font-medium'
                : 'border-transparent text-muted hover:text-gray-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* content */}
      {tab === 'competitors' && <CompetitorsView />}
      {tab === 'search' && (
        <p className="py-10 text-center text-muted">
          Поиск по запросам — следующий этап.
        </p>
      )}
      {tab === 'top' && <TopReelsView />}
    </main>
  );
}
