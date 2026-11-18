// SamSpy — CarouselsView (tab «Карусели», Instagram only)
// Paste Instagram carousel links → collect slide texts (Apify + Claude OCR).
// While this tab is open it keeps advancing unfinished jobs (POST …/step);
// closing the tab pauses them, reopening resumes.
//
// Version history:
//   v0.4.0 (2026-11-18) — create job, jobs list with progress, result table (one post per row),
//                         CSV download, copy for Google Sheets.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CarouselJobCard, CarouselPostFull, CarouselJobStatus } from '@/lib/carousels/types';
import { buildTable, toTsv } from '@/lib/carousels/table';

const STATUS: Record<CarouselJobStatus, { label: string; cls: string }> = {
  apify: { label: 'Apify собирает посты', cls: 'bg-amber-50 text-amber-700' },
  ocr: { label: 'Распознаю текст', cls: 'bg-blue-50 text-blue-700' },
  check: { label: 'Проверка', cls: 'bg-blue-50 text-blue-700' },
  escalate: { label: 'Перепроверка', cls: 'bg-blue-50 text-blue-700' },
  done: { label: 'Готово', cls: 'bg-green-50 text-green-700' },
  failed: { label: 'Ошибка', cls: 'bg-red-50 text-red-700' },
};

const isActive = (s: CarouselJobStatus) => s !== 'done' && s !== 'failed';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function CarouselsView() {
  const [jobs, setJobs] = useState<CarouselJobCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
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
              setJobs((prev) => prev.map((x) => (x.id === data.job.id ? data.job : x)));
            }
            // apify waits on the other side; busy = another tab works on it
            if (data.busy || data.job?.status === 'apify') await sleep(4000);
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
    return <JobDetail jobId={openId} job={job} onBack={() => setOpenId(null)} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <CreateJob
        onCreated={(job) => {
          setJobs((prev) => [job, ...prev]);
        }}
      />

      {jobs.length > 0 && (
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
function CreateJob({ onCreated }: { onCreated: (job: CarouselJobCard) => void }) {
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
        onCreated(data.job);
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
        Ссылки на посты, по одной в строке. ~$0.002 за карусель (Apify + распознавание). Уже
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
          {err && <span className="text-xs text-red-600">{err}</span>}
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
  jobId, job, onBack,
}: {
  jobId: string;
  job: CarouselJobCard | null;
  onBack: () => void;
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
        <div className="overflow-x-auto rounded-xl border border-edge bg-white shadow-sm">
          <table className="min-w-full border-collapse text-xs">
            <thead className="bg-gray-50 text-left text-muted">
              <tr>
                <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 font-medium">Пост</th>
                <th className="px-3 py-2 font-medium">Хук</th>
                {table.slideCols.map((i) => (
                  <th key={i} className="px-3 py-2 font-medium">
                    Слайд {i}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">CTA</th>
                <th className="px-3 py-2 font-medium">Подпись</th>
              </tr>
            </thead>
            <tbody>
              {[...ready, ...failed].map((p) => (
                <PostRow key={p.id} post={p} slideCols={table.slideCols} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const cell = 'min-w-[200px] max-w-[260px] whitespace-pre-wrap align-top px-3 py-2 text-gray-900';

function PostRow({ post, slideCols }: { post: CarouselPostFull; slideCols: number[] }) {
  const cover = post.slides[0]?.image_url;
  const isBody = (s: CarouselPostFull['slides'][number]) =>
    (s.role === 'body' || s.role === 'body+cta') && !!s.text;
  const hook = post.slides.find((s) => s.role === 'hook')?.text ?? '';
  const cta = post.slides.filter((s) => s.cta_text).map((s) => s.cta_text).join('\n\n');
  const escalated = post.slides.filter((s) => s.check_status === 'escalated').map((s) => s.idx);

  return (
    <tr className="border-t border-edge">
      <td className="sticky left-0 z-10 w-[150px] bg-white px-3 py-2 align-top">
        <a href={post.url} target="_blank" rel="noreferrer" className="block">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cover} alt="" className="mb-1 h-24 w-20 rounded-md object-cover" />
          ) : (
            <div className="mb-1 h-24 w-20 rounded-md bg-gray-100" />
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
        {post.error && <div className="text-red-600">{post.error}</div>}
      </td>
      <td className={`${cell} font-medium`}>{hook}</td>
      {slideCols.map((i) => {
        const s = post.slides.find((x) => x.idx === i && isBody(x));
        return (
          <td key={i} className={cell}>
            {s?.text ?? ''}
          </td>
        );
      })}
      <td className={`${cell} text-muted`}>{cta}</td>
      <td className={`${cell} text-muted`}>{post.caption ?? ''}</td>
    </tr>
  );
}
