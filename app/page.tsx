// SamSpy — home page
//   v0.1.0 (2026-11-17) — three tabs; competitors + top live.
//   v0.1.1 (2026-11-17) — logout button (auth).
//   v0.3.0 (2026-11-17) — platform pills (Instagram | TikTok) above the tabs;
//                         each platform has its own three tabs + data.
//   v0.4.0 (2026-11-18) — «Слайды» tab (AI slide generator). Not tied to a
//                         platform, so the platform pills hide on it.
//   v0.5.0 (2026-11-18) — merged «Карусели» tab (Instagram only): carousel slide
//                         texts via Apify + Claude OCR (from the carousels branch).
'use client';

import { useState } from 'react';
import type { Platform } from '@/lib/types/db';
import CompetitorsView from './components/CompetitorsView';
import TopReelsView from './components/TopReelsView';
import SearchView from './components/SearchView';
import SlidesView from './components/SlidesView';
import CarouselsView from './components/CarouselsView';

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

type Tab = 'competitors' | 'search' | 'top' | 'carousels' | 'slides';

// platforms: tab shown only for these platforms (omit = all platforms)
const TABS: { id: Tab; label: string; platforms?: Platform[] }[] = [
  { id: 'competitors', label: 'По конкурентам' },
  { id: 'search', label: 'По поисковым запросам' },
  { id: 'top', label: 'Топ' },
  { id: 'carousels', label: 'Карусели', platforms: ['instagram'] },
  { id: 'slides', label: 'Слайды' },
];

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok', label: 'TikTok' },
];

export default function Home() {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [tab, setTab] = useState<Tab>('competitors');

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      {/* brand + logout */}
      <div className="mb-5 flex items-center justify-between">
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

      {/* platform pills — not shown on the slides tab */}
      {tab !== 'slides' && (
        <div className="mb-5 flex gap-2">
          {PLATFORMS.map((pf) => {
            const active = platform === pf.id;
            return (
              <button
                key={pf.id}
                onClick={() => {
                  setPlatform(pf.id);
                  // «Карусели» exists only for Instagram
                  const t = TABS.find((x) => x.id === tab);
                  if (t?.platforms && !t.platforms.includes(pf.id)) setTab('competitors');
                }}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                  active
                    ? 'bg-accent text-white'
                    : 'border border-edge bg-white text-muted hover:text-gray-900'
                }`}
              >
                {pf.label}
              </button>
            );
          })}
        </div>
      )}

      {/* tabs */}
      <div className="mb-6 flex gap-1 border-b border-edge">
        {TABS.filter((t) => !t.platforms || t.platforms.includes(platform)).map((t) => (
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

      {/* content — keyed by platform so switching resets view state */}
      {tab === 'competitors' && (
        <CompetitorsView key={platform} platform={platform} />
      )}
      {tab === 'search' && <SearchView key={platform} platform={platform} />}
      {tab === 'top' && <TopReelsView key={platform} platform={platform} />}
      {tab === 'carousels' && platform === 'instagram' && <CarouselsView />}
      {/* slides stays mounted so generated images survive tab switches */}
      <div className={tab === 'slides' ? '' : 'hidden'}>
        <SlidesView visible={tab === 'slides'} />
      </div>
    </main>
  );
}
