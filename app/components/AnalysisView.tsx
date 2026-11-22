// SamSpy — AnalysisView («Анализ» tab, Instagram)
//
// Home: link / @username → dossier job; cards of all analysed accounts (median, % outliers,
// posts per week, monthly trend). While the tab is open it advances unfinished jobs
// (POST /api/analysis/jobs/:id/step). Dossier: profile header with the 9 latest posts,
// number tiles, content mix, months, weekdays / hours, list of every post of the year
// with ×median, filters and sorting.
//
// Version history:
//   v0.1.0 (2026-11-22) — stage 1: collection + numbers (AI dossier comes in stage 2).
//   v0.2.0 (2026-11-22) — «Обновить» = quick update (only new posts); «Пересобрать за год» =
//                         full collection; card buttons always visible.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountCard, AccountStats, Dossier, KindStats, PostKind, PostRow } from '@/lib/analysis/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ACTIVE = ['apify', 'save', 'thumbs', 'stats'];
const isActive = (s?: string | null) => !!s && ACTIVE.includes(s);

// --- formatting -----------------------------------------------------------------------
function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  const a = Math.abs(n);
  const f = (x: number) => x.toLocaleString('ru-RU', { maximumFractionDigits: x < 10 ? 2 : 1 });
  if (a >= 1e6) return `${f(n / 1e6)} млн`;
  if (a >= 1e3) return `${f(n / 1e3)} тыс`;
  return Math.round(n).toLocaleString('ru-RU');
}
const fmtPct = (n: number | null | undefined, d = 1) =>
  n == null ? '—' : `${n.toLocaleString('ru-RU', { maximumFractionDigits: d })}%`;
const fmtX = (n: number | null | undefined) =>
  n == null ? '—' : `×${n.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');
const fmtSec = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)} с`);
const KIND_LABEL: Record<PostKind, string> = { reel: 'Reels', carousel: 'Карусель', photo: 'Фото' };
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function Trend({ x }: { x: number | null }) {
  if (x == null) return <span>—</span>;
  const up = x >= 1;
  return (
    <span className={up ? 'text-green-700' : 'text-red-600'}>
      {up ? '↑' : '↓'} {fmtX(x)}
    </span>
  );
}

function Tile({ value, label, hint }: { value: React.ReactNode; label: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-edge bg-white p-4" title={hint}>
      <div className="font-mono text-xl font-semibold">{value}</div>
      <div className="mt-1 text-xs leading-snug text-muted">{label}</div>
    </div>
  );
}

function Bar({ value, max, good }: { value: number; max: number; good?: boolean }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
      <div
        className={`h-full rounded-full ${good ? 'bg-green-600' : 'bg-gray-400'}`}
        style={{ width: `${max > 0 ? Math.max(2, (100 * value) / max) : 0}%` }}
      />
    </div>
  );
}

// ======================================================================================
export default function AnalysisView() {
  const [cards, setCards] = useState<AccountCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openUser, setOpenUser] = useState<string | null>(null);
  const cardsRef = useRef<AccountCard[]>([]);

  const replaceCards = (list: AccountCard[]) => {
    cardsRef.current = list;
    setCards(list);
  };
  const upsertCard = (c: AccountCard) => {
    const list = cardsRef.current.some((x) => x.username === c.username)
      ? cardsRef.current.map((x) => (x.username === c.username ? c : x))
      : [c, ...cardsRef.current];
    replaceCards(list);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/analysis');
      const data = await res.json();
      if (data.cards) replaceCards(data.cards);
      else if (data.error) setNotice(data.error);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // keep advancing unfinished jobs while the tab is open
  useEffect(() => {
    let alive = true;
    (async () => {
      while (alive) {
        const active = cardsRef.current.filter((c) => isActive(c.job?.status));
        if (!active.length) {
          await sleep(2000);
          continue;
        }
        for (const c of active) {
          if (!alive) break;
          try {
            const res = await fetch(`/api/analysis/jobs/${c.job!.id}/step`, { method: 'POST' });
            const data = await res.json();
            if (data.card && alive) upsertCard(data.card);
            if (data.busy || data.card?.job?.status === 'apify') await sleep(5000);
          } catch {
            await sleep(5000);
          }
        }
        await sleep(1500);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function create(value = input, mode: 'update' | 'full' = 'update') {
    if (!value.trim() || creating) return;
    setCreating(true);
    setNotice(null);
    try {
      const res = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: value, mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      upsertCard(data.card);
      setInput('');
      setNotice(
        data.card.job?.mode === 'update'
          ? `@${data.card.username}: собираю новые посты — обычно пара минут.`
          : `@${data.card.username}: сбор за год запущен — это займёт несколько минут. Вкладку можно не держать открытой, продолжится при следующем заходе.`
      );
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function remove(username: string) {
    if (!confirm(`Удалить досье @${username} со всеми данными?`)) return;
    await fetch(`/api/analysis/${username}`, { method: 'DELETE' });
    replaceCards(cardsRef.current.filter((c) => c.username !== username));
  }

  if (openUser) {
    const card = cards.find((c) => c.username === openUser) ?? null;
    return (
      <DossierView
        username={openUser}
        card={card}
        onBack={() => setOpenUser(null)}
        onRefresh={(mode) => void create(openUser, mode)}
      />
    );
  }

  const shown = cards.filter(
    (c) =>
      !query.trim() ||
      c.username.includes(query.trim().toLowerCase().replace(/^@/, '')) ||
      (c.full_name ?? '').toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-edge bg-white p-5">
        <h2 className="text-base font-semibold">Досье на Instagram-аккаунт</h2>
        <p className="mt-1 text-sm text-muted">
          Ссылка или @имя → профиль и все посты за последний год (Reels, карусели, фото), цифры и разбор.
          Сбор идёт несколько минут.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="instagram.com/hormozi или @hormozi"
            className="h-10 min-w-[260px] flex-1 rounded-lg border border-edge px-3 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={() => void create()}
            disabled={creating || !input.trim()}
            className="h-10 rounded-lg bg-accent px-5 text-sm font-medium text-white disabled:opacity-40"
          >
            {creating ? 'Запускаю…' : 'Собрать досье'}
          </button>
        </div>
        {notice && <p className="mt-2 text-xs text-muted">{notice}</p>}
      </div>

      {cards.length > 3 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найти блогера"
          className="h-10 w-full rounded-lg border border-edge bg-white px-3 text-sm outline-none focus:border-accent"
        />
      )}

      {loading ? (
        <p className="text-sm text-muted">Загрузка…</p>
      ) : !cards.length ? (
        <p className="text-sm text-muted">Пока нет ни одного досье.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((c) => (
            <AccountCardView
              key={c.username}
              card={c}
              onOpen={() => setOpenUser(c.username)}
              onRefresh={(mode) => void create(c.username, mode)}
              onDelete={() => void remove(c.username)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- account card ----------------------------------------------------------------------------
function AccountCardView({
  card: c,
  onOpen,
  onRefresh,
  onDelete,
}: {
  card: AccountCard;
  onOpen: () => void;
  onRefresh: (mode: 'update' | 'full') => void;
  onDelete: () => void;
}) {
  const running = isActive(c.job?.status);
  const failed = c.job?.status === 'failed';
  const canOpen = !!c.last_job_id;
  return (
    <div
      onClick={() => canOpen && onOpen()}
      className={`group relative rounded-2xl border border-edge bg-white p-4 ${canOpen ? 'cursor-pointer hover:border-accent' : ''}`}
    >
      <div className="flex items-center gap-3">
        {c.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.avatar} alt="" className="h-12 w-12 rounded-full object-cover" />
        ) : (
          <div className="h-12 w-12 rounded-full bg-gray-100" />
        )}
        <div className="min-w-0">
          <p className="truncate font-semibold">{c.full_name || c.username}</p>
          <p className="truncate text-sm text-muted">
            @{c.username}
            {c.verified ? ' ✓' : ''}
            {c.followers != null ? ` · ${fmtNum(c.followers)}` : ''}
          </p>
        </div>
      </div>

      {running && <p className="mt-3 text-xs text-accent">{c.job?.progress ?? 'В работе…'}</p>}
      {failed && <p className="mt-3 text-xs text-red-600">Ошибка: {c.job?.error}</p>}

      {c.summary && (
        <div className="mt-4 grid grid-cols-4 gap-2 border-t border-edge pt-3 text-center">
          <div>
            <div className="font-mono text-sm font-semibold">{fmtNum(c.summary.median_views)}</div>
            <div className="text-[11px] text-muted">медиана</div>
          </div>
          <div>
            <div className="font-mono text-sm font-semibold">{fmtPct(c.summary.outliers_pct, 0)}</div>
            <div className="text-[11px] text-muted">залётов</div>
          </div>
          <div>
            <div className="font-mono text-sm font-semibold">
              {c.summary.per_week.toLocaleString('ru-RU')}
            </div>
            <div className="text-[11px] text-muted">в неделю</div>
          </div>
          <div>
            <div className="font-mono text-sm font-semibold">
              <Trend x={c.summary.trend} />
            </div>
            <div className="text-[11px] text-muted">за месяц</div>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-3 border-t border-edge pt-3 text-xs" onClick={(e) => e.stopPropagation()}>
        {!running && (
          <button
            onClick={() => onRefresh('update')}
            title={canOpen ? 'Собрать только новые посты (с запасом 14 дней) и пересчитать цифры' : 'Собрать посты за год'}
            className="font-medium text-accent hover:underline"
          >
            {canOpen ? '↻ Обновить' : failed ? 'Повторить' : ''}
          </button>
        )}
        {!running && canOpen && (
          <button
            onClick={() => onRefresh('full')}
            title="Заново собрать все посты за год (свежие цифры по всем постам)"
            className="text-muted hover:text-gray-900"
          >
            Пересобрать за год
          </button>
        )}
        <button onClick={onDelete} className="ml-auto text-muted hover:text-red-600">
          Удалить
        </button>
      </div>
    </div>
  );
}

// ======================================================================================
type SortKey = 'ratio' | 'metric' | 'likes' | 'comments' | 'date';
type KindFilter = 'all' | PostKind;

function DossierView({
  username,
  card,
  onBack,
  onRefresh,
}: {
  username: string;
  card: AccountCard | null;
  onBack: () => void;
  onRefresh: (mode: 'update' | 'full') => void;
}) {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastJob = card?.last_job_id;

  useEffect(() => {
    let off = false;
    setError(null);
    fetch(`/api/analysis/${username}`)
      .then((r) => r.json())
      .then((d) => {
        if (off) return;
        if (d.dossier) setDossier(d.dossier);
        else setError(d.error ?? 'Не удалось загрузить досье.');
      })
      .catch((e) => !off && setError(String(e)));
    return () => {
      off = true;
    };
  }, [username, lastJob]);

  const running = isActive(card?.job?.status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button onClick={onBack} className="text-muted hover:text-gray-900">
          ← Все досье
        </button>
        <span className="font-mono text-xs uppercase tracking-wider text-muted">
          Досье{dossier ? ` · срез ${fmtDate(dossier.job.created_at)} · посты с ${fmtDate(dossier.stats.period.from)}` : ''}
        </span>
        <span className="ml-auto">
          {running ? (
            <span className="text-xs text-accent">Обновляется: {card?.job?.progress}</span>
          ) : (
            <span className="flex gap-4">
              <button
                onClick={() => onRefresh('update')}
                title="Собрать только новые посты (с запасом 14 дней) и пересчитать цифры"
                className="font-medium text-accent hover:underline"
              >
                ↻ Обновить
              </button>
              <button
                onClick={() => onRefresh('full')}
                title="Заново собрать все посты за год"
                className="text-muted hover:text-gray-900"
              >
                Пересобрать за год
              </button>
            </span>
          )}
        </span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!dossier && !error && <p className="text-sm text-muted">Загрузка…</p>}
      {dossier && <DossierBody d={dossier} />}
    </div>
  );
}

function DossierBody({ d }: { d: Dossier }) {
  const s = d.stats;
  const a = d.account;
  const latest = useMemo(
    () =>
      [...d.posts]
        .filter((p) => !p.is_pinned)
        .sort((x, y) => (y.posted_at ?? '').localeCompare(x.posted_at ?? ''))
        .slice(0, 9),
    [d.posts]
  );
  const bySc = useMemo(() => new Map(d.posts.map((p) => [p.shortcode, p])), [d.posts]);

  return (
    <>
      {/* header */}
      <div className="grid gap-6 rounded-2xl border border-edge bg-white p-6 lg:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="flex items-center gap-5">
            {a.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={a.avatar} alt="" className="h-24 w-24 rounded-full object-cover ring-2 ring-pink-400 ring-offset-2" />
            ) : (
              <div className="h-24 w-24 rounded-full bg-gray-100" />
            )}
            <div>
              <p className="text-xl font-bold">
                {a.username} {a.verified && <span className="text-blue-500">✓</span>}
              </p>
              <div className="mt-2 flex flex-wrap gap-6 font-mono text-sm">
                <span>
                  <b>{fmtNum(a.posts_count)}</b> <span className="font-sans text-muted">публикаций</span>
                </span>
                <span>
                  <b>{fmtNum(a.followers)}</b> <span className="font-sans text-muted">подписчиков</span>
                </span>
                <span>
                  <b>{fmtNum(a.follows)}</b> <span className="font-sans text-muted">подписок</span>
                </span>
              </div>
            </div>
          </div>
          {a.full_name && <p className="mt-4 font-semibold">{a.full_name}</p>}
          {a.category && <p className="text-sm text-muted">{a.category}</p>}
          {a.biography && <p className="mt-2 whitespace-pre-line text-sm">{a.biography}</p>}
          {a.external_url && (
            <a href={a.external_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-green-700 underline">
              🔗 {a.external_url.replace(/^https?:\/\//, '').slice(0, 60)}
            </a>
          )}
        </div>
        <div className="grid w-full max-w-[420px] grid-cols-3 gap-1.5">
          {latest.map((p) => (
            <a key={p.shortcode} href={p.url} target="_blank" rel="noreferrer" className="relative block aspect-[3/4] overflow-hidden rounded-lg bg-gray-100">
              {p.thumb && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
              )}
              <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">
                {p.kind === 'reel' ? `▶ ${fmtNum(p.views)}` : `♥ ${fmtNum(p.likes)}`}
              </span>
            </a>
          ))}
        </div>
      </div>

      {/* tiles — reels */}
      {s.reels.count > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-bold">Reels · {s.reels.count} за период</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Tile value={fmtNum(s.reels.median)} label="медиана просмотров" />
            <Tile value={`${s.reels.outliers} из ${s.reels.count}`} label="залётов от 2× медианы" />
            <BestTile k={s.reels} post={s.reels.best ? bySc.get(s.reels.best.shortcode) : undefined} label="лучший ролик" />
            <Tile value={<Trend x={s.reels.trend} />} label="медиана за месяц к прошлым" />
            <Tile value={s.reels.per_week.toLocaleString('ru-RU')} label="рилсов в неделю" />
            <Tile value={fmtPct(s.reels.likes_pct, 2)} label="лайков от просмотров" />
            <Tile value={s.reels.comments_per_1000?.toLocaleString('ru-RU') ?? '—'} label="комментов на 1000 просмотров" />
            <Tile
              value={fmtSec(s.reels.median_duration)}
              label={`типичная длина${s.reels.outliers_median_duration != null ? ` (у залётов ${fmtSec(s.reels.outliers_median_duration)})` : ''}`}
            />
          </div>
        </section>
      )}

      {/* tiles — carousels / photos */}
      {s.carousels.count + s.photos.count > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-bold">
            Карусели · {s.carousels.count}
            {s.photos.count ? ` · фото · ${s.photos.count}` : ''}
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {s.carousels.count > 0 && (
              <>
                <Tile value={fmtNum(s.carousels.median)} label="медиана лайков карусели" />
                <Tile value={`${s.carousels.outliers} из ${s.carousels.count}`} label="залётов от 2× медианы" />
                <BestTile k={s.carousels} post={s.carousels.best ? bySc.get(s.carousels.best.shortcode) : undefined} label="лучшая карусель, лайков" />
                <Tile value={<Trend x={s.carousels.trend} />} label="медиана за месяц к прошлым" />
                <Tile value={s.carousels.per_week.toLocaleString('ru-RU')} label="каруселей в неделю" />
                <Tile value={s.carousels.median_slides ?? '—'} label="слайдов в карусели (медиана)" />
                <Tile value={s.carousels.comments_per_1000?.toLocaleString('ru-RU') ?? '—'} label="комментов на 1000 лайков" />
              </>
            )}
            {s.photos.count > 0 && <Tile value={fmtNum(s.photos.median)} label="медиана лайков фото" />}
          </div>
        </section>
      )}

      {/* tiles — overall */}
      <section>
        <h3 className="mb-3 text-lg font-bold">Аккаунт в целом</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Tile value={s.total} label={`постов за ${Math.round(s.period.days / 30)} мес.`} />
          <Tile value={s.per_week.toLocaleString('ru-RU')} label="постов в неделю" />
          <Tile value={fmtPct(s.cta_pct, 0)} label="с призывом в подписи" />
          <Tile value={fmtPct(s.collab_pct, 0)} label="коллабы с соавтором" />
          <Tile value={fmtPct(s.engagement_pct, 2)} label="ER: медиана (лайки + комменты) ÷ подписчики" />
        </div>
        <MixBar s={s} />
      </section>

      <MonthsChart s={s} />
      <TimeCharts s={s} />
      <PostsList posts={d.posts} />

      <p className="rounded-xl border border-dashed border-edge p-4 text-sm text-muted">
        Скоро здесь появится AI-разбор: о чём блог, рубрики, аудитория по комментариям, подача, что продаёт,
        формула залётов, разбор и текст топовых роликов.
      </p>
    </>
  );
}

function BestTile({ k, post, label }: { k: KindStats; post?: PostRow; label: string }) {
  if (!k.best) return <Tile value="—" label={label} />;
  return (
    <a href={post?.url} target="_blank" rel="noreferrer" className="block">
      <Tile value={fmtNum(k.best.value)} label={`${label} ↗`} />
    </a>
  );
}

function MixBar({ s }: { s: AccountStats }) {
  const parts = [
    { label: 'Reels', n: s.reels.count, cls: 'bg-accent' },
    { label: 'Карусели', n: s.carousels.count, cls: 'bg-green-600' },
    { label: 'Фото', n: s.photos.count, cls: 'bg-amber-500' },
  ].filter((p) => p.n > 0);
  if (!s.total) return null;
  return (
    <div className="mt-4 rounded-xl border border-edge bg-white p-4">
      <div className="flex h-3 overflow-hidden rounded-full">
        {parts.map((p) => (
          <div key={p.label} className={p.cls} style={{ width: `${(100 * p.n) / s.total}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${p.cls}`} />
            {p.label}: {p.n} ({Math.round((100 * p.n) / s.total)}%)
          </span>
        ))}
      </div>
    </div>
  );
}

function MonthsChart({ s }: { s: AccountStats }) {
  const hasReels = s.reels.count > 0;
  const hasPosts = s.carousels.count + s.photos.count > 0;
  const [mode, setMode] = useState<'reels' | 'posts'>(hasReels ? 'reels' : 'posts');
  const vals = s.monthly.map((m) => (mode === 'reels' ? m.reels_median_views : m.posts_median_likes) ?? 0);
  const max = Math.max(1, ...vals);
  const accMedian = mode === 'reels' ? s.reels.median : s.carousels.median;
  if (!s.monthly.length) return null;
  return (
    <section className="rounded-2xl border border-edge bg-white p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h3 className="mr-auto text-lg font-bold">По месяцам</h3>
        {hasReels && hasPosts && (
          <div className="flex gap-1 text-xs">
            {(['reels', 'posts'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1 ${mode === m ? 'bg-accent text-white' : 'border border-edge text-muted'}`}
              >
                {m === 'reels' ? 'Медиана просмотров Reels' : 'Медиана лайков постов'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex h-48 items-end gap-1.5">
        {s.monthly.map((m, i) => (
          <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${m.month}: ${fmtNum(vals[i])} · постов ${m.posts}`}>
            <span className="text-[10px] text-muted">{vals[i] ? fmtNum(vals[i]) : ''}</span>
            <div
              className={`w-full rounded-t ${accMedian && vals[i] >= accMedian ? 'bg-green-600' : 'bg-gray-300'}`}
              style={{ height: `${(100 * vals[i]) / max}%`, minHeight: vals[i] ? 2 : 0 }}
            />
            <span className="text-[10px] text-muted">{m.month.slice(5)}.{m.month.slice(2, 4)}</span>
            <span className="text-[10px] text-muted">{m.posts}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">Зелёные — выше медианы за год. Внизу — число постов в месяце.</p>
    </section>
  );
}

function TimeCharts({ s }: { s: AccountStats }) {
  const block = (title: string, labels: string[], list: AccountStats['by_weekday']) => {
    const maxCount = Math.max(1, ...list.map((b) => b.count));
    return (
      <div className="rounded-2xl border border-edge bg-white p-5">
        <h3 className="mb-3 font-bold">{title}</h3>
        <div className="space-y-1.5">
          {list.map((b, i) =>
            b.count ? (
              <div key={i} className="grid grid-cols-[32px_1fr_110px] items-center gap-3 text-xs">
                <span className="text-muted">{labels[i]}</span>
                <Bar value={b.count} max={maxCount} good={(b.median_ratio ?? 0) >= 1} />
                <span className="text-right font-mono text-muted">
                  {b.count} · {fmtX(b.median_ratio)}
                </span>
              </div>
            ) : null
          )}
        </div>
      </div>
    );
  };
  return (
    <section>
      <div className="grid gap-4 lg:grid-cols-2">
        {block('Дни недели', WEEKDAYS, s.by_weekday)}
        {block(
          'Часы публикации (по Киеву)',
          s.by_hour.map((_, h) => `${String(h).padStart(2, '0')}`),
          s.by_hour
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        Число постов · медиана результата к медиане аккаунта. Зелёные — посты в это время заходят лучше обычного.
      </p>
    </section>
  );
}

// --- posts list ---------------------------------------------------------------------------------
function PostsList({ posts }: { posts: PostRow[] }) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [onlyOutliers, setOnlyOutliers] = useState(false);
  const [sort, setSort] = useState<SortKey>('ratio');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(50);

  const counts = useMemo(
    () => ({
      all: posts.length,
      reel: posts.filter((p) => p.kind === 'reel').length,
      carousel: posts.filter((p) => p.kind === 'carousel').length,
      photo: posts.filter((p) => p.kind === 'photo').length,
    }),
    [posts]
  );

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const metric = (p: PostRow) => (p.kind === 'reel' ? p.views : p.likes) ?? -1;
    const key: Record<SortKey, (p: PostRow) => number> = {
      ratio: (p) => p.ratio ?? -1,
      metric,
      likes: (p) => p.likes ?? -1,
      comments: (p) => p.comments ?? -1,
      date: (p) => (p.posted_at ? new Date(p.posted_at).getTime() : 0),
    };
    return posts
      .filter((p) => kind === 'all' || p.kind === kind)
      .filter((p) => !onlyOutliers || (p.ratio ?? 0) >= 2)
      .filter((p) => !needle || (p.caption ?? '').toLowerCase().includes(needle))
      .sort((a, b) => key[sort](b) - key[sort](a));
  }, [posts, kind, onlyOutliers, sort, q]);

  return (
    <section>
      <h3 className="mb-3 text-lg font-bold">Все посты за период</h3>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        {(['all', 'reel', 'carousel', 'photo'] as KindFilter[])
          .filter((k) => k === 'all' || counts[k] > 0)
          .map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-full px-3 py-1.5 ${kind === k ? 'bg-gray-900 text-white' : 'border border-edge bg-white text-muted hover:text-gray-900'}`}
            >
              {k === 'all' ? 'Все' : KIND_LABEL[k]} ({counts[k]})
            </button>
          ))}
        <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-muted">
          <input type="checkbox" checked={onlyOutliers} onChange={(e) => setOnlyOutliers(e.target.checked)} />
          только залёты (≥ ×2)
        </label>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по подписи"
          className="ml-auto h-8 w-56 rounded-lg border border-edge bg-white px-3 outline-none focus:border-accent"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="h-8 rounded-lg border border-edge bg-white px-2"
        >
          <option value="ratio">по ×медиане</option>
          <option value="metric">по просмотрам / лайкам</option>
          <option value="likes">по лайкам</option>
          <option value="comments">по комментам</option>
          <option value="date">по дате</option>
        </select>
      </div>

      <div className="space-y-3">
        {list.slice(0, limit).map((p, i) => (
          <PostItemRow key={p.shortcode} p={p} n={i + 1} />
        ))}
      </div>
      {list.length > limit && (
        <button
          onClick={() => setLimit((l) => l + 50)}
          className="mt-4 w-full rounded-lg border border-edge bg-white py-2 text-sm font-medium"
        >
          Показать ещё ({list.length - limit})
        </button>
      )}
      {!list.length && <p className="text-sm text-muted">Ничего не найдено.</p>}
    </section>
  );
}

function PostItemRow({ p, n }: { p: PostRow; n: number }) {
  const [open, setOpen] = useState(false);
  const first = (p.caption ?? '').split('\n').find((l) => l.trim()) ?? '';
  const title = first.length > 110 ? `${first.slice(0, 110)}…` : first || '(без подписи)';
  return (
    <div className="flex gap-4 rounded-xl border border-edge bg-white p-3">
      <a href={p.url} target="_blank" rel="noreferrer" className="block h-28 w-20 shrink-0 overflow-hidden rounded-lg bg-gray-100">
        {p.thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
        )}
      </a>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          №{n}. {title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-mono font-semibold">
            {p.kind === 'reel' ? `${fmtNum(p.views)} просм.` : `${fmtNum(p.likes)} лайков`}
          </span>
          {p.ratio != null && (
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-xs ${
                p.ratio >= 2 ? 'bg-amber-100 text-amber-800' : p.ratio >= 1 ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-muted'
              }`}
            >
              {fmtX(p.ratio)}
            </span>
          )}
          <span className="text-muted">{fmtDate(p.posted_at)}</span>
          {p.kind === 'reel' && p.duration != null && <span className="text-muted">{fmtSec(p.duration)}</span>}
          {p.kind === 'carousel' && p.slides != null && <span className="text-muted">{p.slides} слайдов</span>}
          {p.kind === 'reel' && <span className="text-muted">♥ {fmtNum(p.likes)}</span>}
          <span className="text-muted">💬 {fmtNum(p.comments)}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
          <span className="rounded-full border border-edge px-2 py-0.5 text-muted">{KIND_LABEL[p.kind]}</span>
          {p.collab && (
            <span className="rounded-full border border-edge px-2 py-0.5 text-muted" title={p.coauthors.join(', ')}>
              коллаб{p.coauthors.length ? `: @${p.coauthors.join(', @')}` : ''}
            </span>
          )}
          {p.has_cta && <span className="rounded-full border border-edge px-2 py-0.5 text-muted">призыв</span>}
          {p.is_pinned && <span className="rounded-full border border-edge px-2 py-0.5 text-muted">закреп</span>}
        </div>
        {p.caption && (
          <button onClick={() => setOpen((o) => !o)} className="mt-2 text-sm text-green-700">
            {open ? '▾' : '▸'} Подпись
          </button>
        )}
        {open && <p className="mt-1 whitespace-pre-line text-sm text-gray-700">{p.caption}</p>}
      </div>
    </div>
  );
}
