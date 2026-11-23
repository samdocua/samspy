// SamSpy — CarouselsView (tab «Карусели», Instagram only)
// Paste Instagram carousel links → collect slide texts (ScrapeCreators + Claude OCR).
// While this tab is open it keeps advancing unfinished jobs (POST …/step);
// closing the tab pauses them, reopening resumes.
//
// Version history:
//   v0.4.0 (2026-11-18) — create job, jobs list with progress, result table (one post per row),
//                         CSV download, copy for Google Sheets.
//   v0.5.0 (2026-11-18) — table cells use joinSoftBreaks (layout line wraps glued).
//   v0.6.0 (2026-11-19) — CTA column removed; «→ В слайды» per post (onSendToSlides).
//   v0.7.0 (2026-11-20) — «База постов» (all collected posts once, search / sort / min outlier,
//                         delete) next to «Задачи»; after «Собрать»: N new / M already in base;
//                         outlier badge (likes ÷ author's median likes); «Дубль» / «Похож на …».
//   v0.7.1 (2026-11-20) — «Посчитать outlier (N)» for posts collected earlier.
//   v0.8.0 (2026-11-23) — wording: posts come from ScrapeCreators (Apify kept as a fallback).
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CarouselJobCard, CarouselPostFull, CarouselJobStatus, CreateJobInfo,
} from '@/lib/carousels/types';
import { buildTable, toTsv } from '@/lib/carousels/table';
import { outlierLabel } from '@/lib/format';
import { joinSoftBreaks } from '@/lib/carousels/postprocess';
import { makeSlidesImport, type SlidesImport } from '@/lib/carousels/toSlides';

const STATUS: Record<CarouselJobStatus, { label: string; cls: string }> = {
  apify: { label: 'Собираю посты', cls: 'bg-amber-50 text-amber-700' },
  ocr: { label: 'Распознаю текст', cls: 'bg-blue-50 text-blue-700' },
  check: { label: 'Проверка', cls: 'bg-blue-50 text-blue-700' },
  escalate: { label: 'Перепроверка', cls: 'bg-blue-50 text-blue-700' },
  stats: { label: 'Считаю outlier', cls: 'bg-blue-50 text-blue-700' },
  done: { label: 'Готово', cls: 'bg-green-50 text-green-700' },
  failed: { label: 'Ошибка', cls: 'bg-red-50 text-red-700' },
};

const isActive = (s: CarouselJobStatus) => s !== 'done' && s !== 'failed';
const OUTLIER_HOT = 3; // badge is highlighted from this ratio

function createdNotice(i: CreateJobInfo): string {
  if (!i.fresh) return `Все ${i.total} уже в базе — новых нет, повторно не собираю.`;
  if (!i.existing) return `${i.total} новых — собираю.`;
  return `${i.total} ссылок: ${i.fresh} новых — собираю, ${i.existing} уже в базе — пропускаю.`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function CarouselsView({
  onSendToSlides,
}: {
  onSendToSlides?: (imp: SlidesImport) => void;
}) {
  const [jobs, setJobs] = useState<CarouselJobCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const [view, setView] = useState<'base' | 'jobs'>('base');
  const [notice, setNotice] = useState<string | null>(null);
  const [baseKey, setBaseKey] = useState(0); // bump → «База постов» reloads
  const jobsRef = useRef<CarouselJobCard[]>([]);
  jobsRef.current = jobs;

  const loadJobs = useCallback(async () => {
    const res = await fetch('/api/carousels/jobs');
    const data = await res.json();
    setJobs(data.jobs ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Worker loop: while the tab is open, keep stepping unfinished jobs one by one.
  useEffect(() => {
    let alive = true;
    (async () => {
      while (alive) {
        const active = jobsRef.current.filter((j) => isActive(j.status));
        if (!active.length) {
          await sleep(2000);
          continue;
        }
        for (const j of active) {
          if (!alive) break;
          try {
            const res = await fetch(`/api/carousels/jobs/${j.id}/step`, { method: 'POST' });
            const data = await res.json();
            if (data.job && alive) {
              if (j.status !== 'done' && data.job.status === 'done') setBaseKey((k) => k + 1);
              setJobs((prev) => prev.map((x) => (x.id === data.job.id ? data.job : x)));
            }
            // apify waits on the other side; busy = another tab works on it
            if (data.busy || data.job?.status === 'apify' || data.job?.status === 'stats') await sleep(4000);
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

  async function deleteJob(id: string) {
    if (!confirm('Удалить задачу? Собранные посты останутся в базе и не будут собираться повторно.')) return;
    await fetch(`/api/carousels/jobs/${id}`, { method: 'DELETE' });
    loadJobs();
  }

  if (openId) {
    const job = jobs.find((j) => j.id === openId) ?? null;
    return (
      <JobDetail
        jobId={openId}
        job={job}
        onBack={() => setOpenId(null)}
        onSendToSlides={onSendToSlides}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <CreateJob
        notice={notice}
        onCreated={(job, info) => {
          setJobs((prev) => [job, ...prev]);
          setNotice(info ? createdNotice(info) : null);
        }}
      />

      <div className="flex items-center gap-1">
        {(
          [
            ['base', 'База постов'],
            ['jobs', `Задачи${jobs.length ? ` (${jobs.length})` : ''}`],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-full px-3 py-1 text-sm ${
              view === v ? 'bg-gray-900 text-white' : 'text-muted hover:text-gray-900'
            }`}
          >
            {label}
          </button>
        ))}
        {view === 'jobs' && jobs.length > 0 && (
          <button
            onClick={() => setManage((m) => !m)}
            className="ml-auto text-sm text-muted hover:text-gray-900"
          >
            {manage ? 'Готово' : 'Управление'}
          </button>
        )}
      </div>

      {view === 'base' ? (
        <BaseView
          refreshKey={baseKey}
          statsRunning={jobs.some((j) => j.status === 'stats')}
          onStatsJob={(job) => setJobs((prev) => [job, ...prev])}
          onSendToSlides={onSendToSlides}
        />
      ) : loading ? (
        <p className="py-10 text-center text-muted">Загрузка…</p>
      ) : jobs.length === 0 ? (
        <p className="py-10 text-center text-muted">
          Пока нет задач. Вставь ссылки на карусели выше — соберу тексты всех слайдов.
        </p>
      ) : (
        <div className="flex flex-col gap-2 pb-10">
          {jobs.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              manage={manage}
              onOpen={() => setOpenId(j.id)}
              onDelete={() => deleteJob(j.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- create ----------------------------------------------------------------
function CreateJob({
  notice,
  onCreated,
}: {
  notice: string | null;
  onCreated: (job: CarouselJobCard, info: CreateJobInfo | null) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const count = new Set(
    Array.from(text.matchAll(/instagram\.com\/(?:[^/\s]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/gi)).map(
      (m) => m[1]
    )
  ).size;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!count || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/carousels/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok || !data.job) {
        setErr(data.error ?? 'Не удалось создать задачу.');
      } else {
        setText('');
        onCreated(data.job, data.info ?? null);
      }
    } catch {
      setErr('Ошибка сети.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-gray-900">Собрать тексты каруселей</h2>
      <p className="mb-3 text-xs text-muted">
        Ссылки на посты, по одной в строке. ~$0.004 за карусель (1 кредит ScrapeCreators + распознавание). Уже
        собранные посты берутся из базы бесплатно. Пока идёт сбор, держи вкладку открытой.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder={'https://www.instagram.com/p/…\nhttps://www.instagram.com/p/…'}
          className="w-full rounded-lg border border-edge bg-ink px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!count || busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Запускаю…' : `Собрать${count ? ` (${count})` : ''}`}
          </button>
          {err ? (
            <span className="text-xs text-red-600">{err}</span>
          ) : (
            notice && <span className="text-xs text-muted">{notice}</span>
          )}
        </div>
      </form>
    </div>
  );
}

// --- job row ---------------------------------------------------------------
function Progress({ job }: { job: CarouselJobCard }) {
  if (job.status === 'ocr' && job.slides_total) {
    const pct = Math.round((job.slides_ocr_done / job.slides_total) * 100);
    return (
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-gray-100">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-muted">
          слайды {job.slides_ocr_done}/{job.slides_total}
        </span>
      </div>
    );
  }
  return (
    <span className="text-xs text-muted">
      постов {job.posts_ready}/{job.posts_total}
    </span>
  );
}

function JobRow({
  job, manage, onOpen, onDelete,
}: {
  job: CarouselJobCard;
  manage: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const st = STATUS[job.status];
  return (
    <div className="flex items-center gap-3 rounded-xl border border-edge bg-white px-4 py-3 shadow-sm">
      <button onClick={onOpen} className="flex flex-1 flex-wrap items-center gap-3 text-left">
        <span className="text-sm font-medium text-gray-900">{fmtDate(job.created_at)}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${st.cls}`}>
          {isActive(job.status) && <span className="mr-1 inline-block animate-pulse">●</span>}
          {st.label}
        </span>
        <Progress job={job} />
        {job.error && <span className="truncate text-xs text-red-600">{job.error}</span>}
      </button>
      {manage ? (
        <button onClick={onDelete} className="text-xs text-red-600 hover:underline">
          Удалить
        </button>
      ) : (
        <button onClick={onOpen} className="text-xs text-accent hover:underline">
          Открыть →
        </button>
      )}
    </div>
  );
}

// --- detail ----------------------------------------------------------------
function JobDetail({
  jobId, job, onBack, onSendToSlides,
}: {
  jobId: string;
  job: CarouselJobCard | null;
  onBack: () => void;
  onSendToSlides?: (imp: SlidesImport) => void;
}) {
  const [posts, setPosts] = useState<CarouselPostFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const status = job?.status;

  const load = useCallback(async () => {
    const res = await fetch(`/api/carousels/jobs/${jobId}`);
    const data = await res.json();
    setPosts(data.posts ?? []);
    setLoading(false);
  }, [jobId]);

  // reload on open and whenever the job status changes (e.g. → done)
  useEffect(() => {
    load();
  }, [load, status]);

  const table = buildTable(posts.filter((p) => p.status === 'ready' || p.status === 'failed'));
  const ready = posts.filter((p) => p.status === 'ready');
  const failed = posts.filter((p) => p.status === 'failed');

  async function copy() {
    await navigator.clipboard.writeText(toTsv(table));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="text-sm text-muted hover:text-gray-900">
          ← Назад
        </button>
        {job && (
          <>
            <span className="text-sm font-medium">{fmtDate(job.created_at)}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[job.status].cls}`}>
              {STATUS[job.status].label}
            </span>
            <Progress job={job} />
          </>
        )}
        <div className="ml-auto flex gap-2">
          <button
            onClick={copy}
            disabled={!table.rows.length}
            className="rounded-lg border border-edge bg-white px-3 py-1.5 text-xs disabled:opacity-40"
          >
            {copied ? 'Скопировано ✓' : 'Скопировать для Google Sheets'}
          </button>
          <a
            href={`/api/carousels/jobs/${jobId}/csv`}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
          >
            Скачать CSV
          </a>
        </div>
      </div>

      {job?.error && <p className="text-xs text-red-600">{job.error}</p>}

      {loading ? (
        <p className="py-10 text-center text-muted">Загрузка…</p>
      ) : !ready.length && !failed.length ? (
        <p className="py-10 text-center text-muted">
          {status && isActive(status) ? 'Собираю… результаты появятся здесь.' : 'Нет результатов.'}
        </p>
      ) : (
        <PostsTable posts={[...ready, ...failed]} onSendToSlides={onSendToSlides} />
      )}
    </div>
  );
}

// --- posts base ----------------------------------------------------------------
type BaseSort = 'recent' | 'likes' | 'outlier';
const PAGE = 50;

function BaseView({
  refreshKey,
  statsRunning,
  onStatsJob,
  onSendToSlides,
}: {
  refreshKey: number;
  statsRunning: boolean;
  onStatsJob: (job: CarouselJobCard) => void;
  onSendToSlides?: (imp: SlidesImport) => void;
}) {
  const [noOutlier, setNoOutlier] = useState(0);
  const [starting, setStarting] = useState(false);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<BaseSort>('recent');
  const [minOutlier, setMinOutlier] = useState(0);
  const [posts, setPosts] = useState<CarouselPostFull[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number) => {
      const params = new URLSearchParams({
        q, sort, min_outlier: String(minOutlier), offset: String(offset), limit: String(PAGE),
      });
      try {
        const res = await fetch(`/api/carousels/posts?${params}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setPosts((prev) => (offset ? [...prev, ...(data.posts ?? [])] : data.posts ?? []));
        setTotal(data.total ?? 0);
        setNoOutlier(data.noOutlier ?? 0);
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
        setMore(false);
      }
    },
    [q, sort, minOutlier]
  );

  // search is debounced; filters / a finished job reload from the first page
  useEffect(() => {
    const t = setTimeout(() => load(0), q ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, q, refreshKey]);

  async function countOutlier() {
    setStarting(true);
    try {
      const res = await fetch('/api/carousels/posts', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.job) onStatsJob(data.job);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function remove(p: CarouselPostFull) {
    if (!confirm(`Удалить пост @${p.author ?? '—'} из базы? Его можно будет собрать заново.`)) return;
    const res = await fetch(`/api/carousels/posts/${p.id}`, { method: 'DELETE' });
    if (!res.ok) return alert('Не удалось удалить.');
    setPosts((prev) => prev.filter((x) => x.id !== p.id));
    setTotal((t) => Math.max(0, t - 1));
  }

  return (
    <div className="flex flex-col gap-3 pb-10">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по тексту или @автору"
          className="w-64 rounded-lg border border-edge bg-white px-3 py-1.5 outline-none focus:border-accent"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as BaseSort)}
          className="rounded-lg border border-edge bg-white px-2 py-1.5"
        >
          <option value="recent">Сначала новые</option>
          <option value="likes">По лайкам</option>
          <option value="outlier">По outlier</option>
        </select>
        <label className="flex items-center gap-1 text-muted">
          outlier от
          <select
            value={minOutlier}
            onChange={(e) => setMinOutlier(Number(e.target.value))}
            className="rounded-lg border border-edge bg-white px-2 py-1.5 text-gray-900"
          >
            {[0, 2, 3, 5, 10, 50].map((v) => (
              <option key={v} value={v}>
                {v ? `${v}x` : 'любой'}
              </option>
            ))}
          </select>
        </label>
        {(noOutlier > 0 || statsRunning) && (
          <button
            onClick={() => void countOutlier()}
            disabled={starting || statsRunning}
            title="Докачает последние посты авторов (2 кредита ScrapeCreators на автора)"
            className="rounded-lg border border-edge bg-white px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {statsRunning ? 'Считаю outlier…' : `Посчитать outlier (${noOutlier})`}
          </button>
        )}
        <span className="ml-auto text-xs text-muted">постов: {total}</span>
      </div>

      {err && <p className="text-xs text-red-600">{err}</p>}
      {loading ? (
        <p className="py-10 text-center text-muted">Загрузка…</p>
      ) : !posts.length ? (
        <p className="py-10 text-center text-muted">
          {q || minOutlier ? 'Ничего не найдено.' : 'База пуста. Вставь ссылки выше — посты появятся здесь.'}
        </p>
      ) : (
        <>
          <PostsTable posts={posts} onSendToSlides={onSendToSlides} onDelete={remove} />
          {posts.length < total && (
            <button
              onClick={() => {
                setMore(true);
                load(posts.length);
              }}
              disabled={more}
              className="self-center rounded-lg border border-edge bg-white px-4 py-2 text-sm disabled:opacity-40"
            >
              {more ? 'Загружаю…' : `Показать ещё (${total - posts.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function PostsTable({
  posts,
  onSendToSlides,
  onDelete,
}: {
  posts: CarouselPostFull[];
  onSendToSlides?: (imp: SlidesImport) => void;
  onDelete?: (p: CarouselPostFull) => void;
}) {
  const { slideCols } = buildTable(posts);
  return (
    <div className="overflow-x-auto rounded-xl border border-edge bg-white shadow-sm">
      <table className="min-w-full border-collapse text-xs">
        <thead className="bg-gray-50 text-left text-muted">
          <tr>
            <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 font-medium">Пост</th>
            <th className="px-3 py-2 font-medium">Хук</th>
            {slideCols.map((i) => (
              <th key={i} className="px-3 py-2 font-medium">
                Слайд {i}
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Подпись</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((p) => (
            <PostRow
              key={p.id}
              post={p}
              slideCols={slideCols}
              onSendToSlides={onSendToSlides}
              onDelete={onDelete}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cell = 'min-w-[200px] max-w-[260px] whitespace-pre-wrap align-top px-3 py-2 text-gray-900';

function PostRow({
  post,
  slideCols,
  onSendToSlides,
  onDelete,
}: {
  post: CarouselPostFull;
  slideCols: number[];
  onSendToSlides?: (imp: SlidesImport) => void;
  onDelete?: (p: CarouselPostFull) => void;
}) {
  const cover = post.slides[0]?.image_url;
  const isBody = (s: CarouselPostFull['slides'][number]) =>
    (s.role === 'body' || s.role === 'body+cta') && !!s.text;
  const hook = joinSoftBreaks(post.slides.find((s) => s.role === 'hook')?.text ?? '');
  const escalated = post.slides.filter((s) => s.check_status === 'escalated').map((s) => s.idx);

  return (
    <tr className="border-t border-edge">
      <td className="sticky left-0 z-10 w-[150px] bg-white px-3 py-2 align-top">
        <a href={post.url} target="_blank" rel="noreferrer" className="relative block w-20">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cover} alt="" className="mb-1 h-24 w-20 rounded-md object-cover" />
          ) : (
            <div className="mb-1 h-24 w-20 rounded-md bg-gray-100" />
          )}
          {post.outlier_ratio != null && (
            <span
              title="Лайки ÷ медиана лайков последних постов автора"
              className={`absolute left-1 top-1 rounded px-1.5 py-0.5 text-[11px] font-bold ${
                post.outlier_ratio >= OUTLIER_HOT ? 'bg-accent text-white' : 'bg-black/70 text-white'
              }`}
            >
              {outlierLabel(post.outlier_ratio)}
            </span>
          )}
          <div className="truncate font-medium text-gray-900">@{post.author ?? '—'}</div>
        </a>
        <div className="text-muted">
          ♥ {post.likes?.toLocaleString('ru-RU') ?? '—'} · {post.slides.length} сл.
        </div>
        {post.brand && <div className="truncate text-muted">{post.brand}</div>}
        {escalated.length > 0 && (
          <div className="text-amber-700">Sonnet: {escalated.join(', ')}</div>
        )}
        {post.duplicate_of && (
          <div className="text-red-600">
            Дубль{' '}
            {post.ref && (
              <a href={post.ref.url} target="_blank" rel="noreferrer" className="underline">
                @{post.ref.author ?? '—'}
              </a>
            )}
          </div>
        )}
        {post.similar_to && (
          <div className="text-amber-700">
            Похож на{' '}
            {post.ref && (
              <a href={post.ref.url} target="_blank" rel="noreferrer" className="underline">
                @{post.ref.author ?? '—'}
              </a>
            )}{' '}
            ({Math.round((post.similarity ?? 0) * 100)}%)
          </div>
        )}
        {post.error && <div className="text-red-600">{post.error}</div>}
        {onSendToSlides && post.status === 'ready' && (
          <button
            onClick={() => onSendToSlides(makeSlidesImport(post))}
            className="mt-2 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white"
          >
            → В слайды
          </button>
        )}
        {onDelete && (
          <button
            onClick={() => onDelete(post)}
            className="mt-1 block text-[11px] text-red-600 hover:underline"
          >
            Удалить из базы
          </button>
        )}
      </td>
      <td className={`${cell} font-medium`}>{hook}</td>
      {slideCols.map((i) => {
        const s = post.slides.find((x) => x.idx === i && isBody(x));
        return (
          <td key={i} className={cell}>
            {joinSoftBreaks(s?.text ?? '')}
          </td>
        );
      })}
      <td className={`${cell} text-muted`}>{post.caption ?? ''}</td>
    </tr>
  );
}
