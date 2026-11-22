// SamSpy — PlanView («План» tab, Instagram carousels)
//
// Content plan: source dossiers («Анализ») + my accounts (I0001, I0002…) → days × posts per
// day carousels written by Claude (cover hook + questions + comment-bait last slide +
// caption). Calendar per account; every carousel can be edited, rewritten, copied, sent to
// «Слайды» (→ «в Слайдах»; «Скачать все» there marks it «готово»). While the tab is open it
// keeps writing plans that are still generating.
//
// Version history:
//   v0.1.0 (2026-11-22) — initial.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SlidesImport } from '@/lib/carousels/toSlides';
import { DEFAULT_CTAS, type ContentPlan, type ItemStatus, type PlanCard, type PlanItem } from '@/lib/plan/types';
import type { AccountCard } from '@/lib/analysis/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const STATUS_LABEL: Record<ItemStatus, string> = { draft: 'черновик', in_slides: 'в Слайдах', done: 'готово' };
const STATUS_CLS: Record<ItemStatus, string> = {
  draft: 'bg-gray-100 text-muted',
  in_slides: 'bg-amber-100 text-amber-800',
  done: 'bg-green-100 text-green-800',
};
const PER_CAROUSEL_USD = 0.02; // rough: Claude Sonnet, batch of 8 with the brief

const inputCls = 'h-10 w-full rounded-lg border border-edge bg-white px-3 text-sm outline-none focus:border-accent';
const labelCls = 'mb-1 block text-xs font-medium text-muted';

function dateOf(start: string, day: number): Date {
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + day - 1);
  return d;
}
const fmtDay = (d: Date) => `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })} ${WEEKDAYS[d.getUTCDay()]}`;

export default function PlanView({ onSendToSlides }: { onSendToSlides?: (imp: SlidesImport) => void }) {
  const [plans, setPlans] = useState<PlanCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const plansRef = useRef<PlanCard[]>([]);
  const [tick, setTick] = useState(0); // bumps after every written batch → open plan reloads

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/plans');
      const data = await res.json();
      if (data.plans) {
        plansRef.current = data.plans;
        setPlans(data.plans);
      } else if (data.error) setNotice(data.error);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // keep writing plans that are still generating while the tab is open
  useEffect(() => {
    let alive = true;
    (async () => {
      while (alive) {
        const gen = plansRef.current.filter((p) => p.status === 'generating');
        if (!gen.length) {
          await sleep(2000);
          continue;
        }
        for (const p of gen) {
          if (!alive) break;
          try {
            const res = await fetch(`/api/plans/${p.id}/step`, { method: 'POST' });
            const data = await res.json();
            if (data.busy) await sleep(5000);
          } catch {
            await sleep(5000);
          }
          await load();
          setTick((t) => t + 1);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  async function remove(id: string) {
    if (!confirm('Удалить план со всеми каруселями?')) return;
    await fetch(`/api/plans/${id}`, { method: 'DELETE' });
    if (openId === id) setOpenId(null);
    await load();
  }

  async function resume(id: string) {
    await fetch(`/api/plans/${id}`, { method: 'POST', body: JSON.stringify({ action: 'resume' }) });
    await load();
  }

  if (openId) {
    const card = plans.find((p) => p.id === openId) ?? null;
    return (
      <PlanDetail
        id={openId}
        card={card}
        tick={tick}
        onBack={() => setOpenId(null)}
        onResume={() => void resume(openId)}
        onDelete={() => void remove(openId)}
        onSendToSlides={onSendToSlides}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-base font-semibold">Контент-планы каруселей</h2>
        {!creating && (
          <button onClick={() => setCreating(true)} className="h-10 rounded-lg bg-accent px-5 text-sm font-medium text-white">
            + Новый план
          </button>
        )}
      </div>
      {notice && <p className="text-xs text-muted">{notice}</p>}

      {creating && (
        <NewPlanForm
          onCancel={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await load();
            setOpenId(id);
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-muted">Загрузка…</p>
      ) : !plans.length ? (
        !creating && <p className="text-sm text-muted">Планов пока нет.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((p) => (
            <div
              key={p.id}
              onClick={() => setOpenId(p.id)}
              className="cursor-pointer rounded-2xl border border-edge bg-white p-4 hover:border-accent"
            >
              <p className="font-semibold">{p.title}</p>
              <p className="mt-1 text-sm text-muted">
                {p.accounts.join(', ')} · {p.days} дн. × {p.per_day} · с {fmtDay(dateOf(p.start_date, 1))}
              </p>
              <p className="mt-1 text-xs text-muted">по досье: {p.sources.map((s) => `@${s}`).join(', ') || '—'}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div className="h-full bg-accent" style={{ width: `${(100 * p.written) / Math.max(1, p.total)}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-muted">
                {p.status === 'generating'
                  ? `Пишу: ${p.written} из ${p.total}…`
                  : p.status === 'failed'
                    ? `Остановилось на ${p.written} из ${p.total}: ${p.error}`
                    : `Готово ${p.done} из ${p.total} · написано ${p.written}`}
              </p>
              <div className="mt-2 flex gap-3 text-xs" onClick={(e) => e.stopPropagation()}>
                {p.status === 'failed' && (
                  <button onClick={() => void resume(p.id)} className="font-medium text-accent">
                    Продолжить
                  </button>
                )}
                <button onClick={() => void remove(p.id)} className="ml-auto text-muted hover:text-red-600">
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- new plan form -------------------------------------------------------------------------------
function NewPlanForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [sources, setSources] = useState<AccountCard[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [accounts, setAccounts] = useState('I0001, I0002');
  const [start, setStart] = useState(tomorrow);
  const [days, setDays] = useState(30);
  const [perDay, setPerDay] = useState(3);
  const [qMin, setQMin] = useState(4);
  const [qMax, setQMax] = useState(6);
  const [language, setLanguage] = useState('English');
  const [ctas, setCtas] = useState(DEFAULT_CTAS.join('\n'));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/analysis')
      .then((r) => r.json())
      .then((d) => {
        const ready = ((d.cards ?? []) as AccountCard[]).filter((c) => c.last_job_id);
        setSources(ready);
        setPicked(new Set(ready.map((c) => c.username)));
      })
      .catch(() => {});
  }, []);

  const accList = accounts.split(/[,\s]+/).filter(Boolean);
  const total = accList.length * days * perDay;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          accounts: accList,
          start_date: start,
          days,
          per_day: perDay,
          q_min: qMin,
          q_max: qMax,
          language,
          cta_variants: ctas.split('\n').map((l) => l.trim()).filter(Boolean),
          notes,
          sources: Array.from(picked),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onCreated(data.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-edge bg-white p-5">
      <div>
        <span className={labelCls}>По каким досье («Анализ»)</span>
        {sources.length ? (
          <div className="flex flex-wrap gap-2">
            {sources.map((c) => (
              <label key={c.username} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-edge px-3 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={picked.has(c.username)}
                  onChange={(e) => {
                    const n = new Set(picked);
                    if (e.target.checked) n.add(c.username);
                    else n.delete(c.username);
                    setPicked(n);
                  }}
                />
                @{c.username}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">Нет готовых досье — сначала собери их во вкладке «Анализ».</p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className={labelCls}>Название</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="План на декабрь" className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Мои аккаунты (через запятую)</span>
          <input value={accounts} onChange={(e) => setAccounts(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Старт</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Язык слайдов</span>
          <input value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Дней</span>
          <input type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Постов в день на аккаунт</span>
          <input type="number" min={1} max={6} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Вопросов в карусели: от</span>
          <input type="number" min={1} max={12} value={qMin} onChange={(e) => setQMin(Number(e.target.value))} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>до</span>
          <input type="number" min={qMin} max={12} value={qMax} onChange={(e) => setQMax(Number(e.target.value))} className={inputCls} />
        </label>
      </div>

      <label className="block">
        <span className={labelCls}>
          Последний слайд — призыв в комменты (по варианту на строку, чередуются по постам, чтобы сравнить)
        </span>
        <textarea value={ctas} onChange={(e) => setCtas(e.target.value)} rows={4} className={`${inputCls} h-auto py-2`} />
      </label>
      <label className="block">
        <span className={labelCls}>Пожелания (необязательно)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Например: I0002 — больше пикантных вопросов; без тем про детей"
          className={`${inputCls} h-auto py-2`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void submit()}
          disabled={busy || !accList.length || !picked.size}
          className="h-10 rounded-lg bg-accent px-5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Создаю…' : `Сгенерировать ${total} каруселей`}
        </button>
        <button onClick={onCancel} className="text-sm text-muted hover:text-gray-900">
          Отмена
        </button>
        <span className="text-xs text-muted">
          ≈ ${(total * PER_CAROUSEL_USD).toFixed(1)} · ≈ {Math.max(1, Math.round((total / 8) * 0.75))} мин, пока вкладка открыта.
          Каждая карусель: обложка + {qMin}–{qMax} вопросов + призыв.
        </span>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

// --- plan detail ----------------------------------------------------------------------------------
function PlanDetail({
  id,
  card,
  tick,
  onBack,
  onResume,
  onDelete,
  onSendToSlides,
}: {
  id: string;
  card: PlanCard | null;
  tick: number;
  onBack: () => void;
  onResume: () => void;
  onDelete: () => void;
  onSendToSlides?: (imp: SlidesImport) => void;
}) {
  const [plan, setPlan] = useState<ContentPlan | null>(null);
  const [items, setItems] = useState<PlanItem[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | ItemStatus>('all');

  const load = useCallback(async () => {
    const res = await fetch(`/api/plans/${id}`);
    const data = await res.json();
    if (data.plan) {
      setPlan(data.plan);
      setItems(data.items);
      setAccount((a) => a ?? data.plan.accounts[0]);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load, tick]);

  const patchLocal = (it: PlanItem) => setItems((list) => list.map((x) => (x.id === it.id ? it : x)));

  const days = useMemo(() => {
    const mine = items.filter((i) => i.account === account && (filter === 'all' || i.status === filter));
    const map = new Map<number, PlanItem[]>();
    for (const it of mine) {
      const l = map.get(it.day);
      if (l) l.push(it);
      else map.set(it.day, [it]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [items, account, filter]);

  if (!plan) return <p className="text-sm text-muted">Загрузка…</p>;
  const mine = items.filter((i) => i.account === account);
  const counts = {
    all: mine.length,
    draft: mine.filter((i) => i.status === 'draft').length,
    in_slides: mine.filter((i) => i.status === 'in_slides').length,
    done: mine.filter((i) => i.status === 'done').length,
  };
  const written = items.filter((i) => i.slides.length).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button onClick={onBack} className="text-muted hover:text-gray-900">
          ← Все планы
        </button>
        <h2 className="text-base font-semibold">{plan.title}</h2>
        <span className="text-xs text-muted">
          по досье {plan.sources.map((s) => `@${s}`).join(', ')} · {plan.settings.language} · вопросов {plan.settings.q_min}–
          {plan.settings.q_max}
        </span>
        <span className="ml-auto flex gap-3">
          {card?.status === 'failed' && (
            <button onClick={onResume} className="font-medium text-accent">
              Продолжить
            </button>
          )}
          <button onClick={onDelete} className="text-muted hover:text-red-600">
            Удалить план
          </button>
        </span>
      </div>

      {written < items.length && (
        <div>
          <div className="mb-1 text-xs text-muted">
            {card?.status === 'failed' ? `Остановилось: ${card.error}` : `Пишу карусели: ${written} из ${items.length}…`}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full bg-accent transition-all" style={{ width: `${(100 * written) / Math.max(1, items.length)}%` }} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {plan.accounts.map((a) => (
          <button
            key={a}
            onClick={() => setAccount(a)}
            className={`rounded-full px-4 py-1.5 font-medium ${account === a ? 'bg-gray-900 text-white' : 'border border-edge bg-white'}`}
          >
            {a}
          </button>
        ))}
        <span className="mx-2 h-5 w-px bg-edge" />
        {(['all', 'draft', 'in_slides', 'done'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs ${filter === f ? 'bg-accent text-white' : 'border border-edge bg-white text-muted'}`}
          >
            {f === 'all' ? 'все' : STATUS_LABEL[f]} {counts[f]}
          </button>
        ))}
      </div>

      <div className="space-y-6">
        {days.map(([day, list]) => (
          <section key={day}>
            <h3 className="mb-2 font-mono text-sm font-semibold">
              День {day} · {fmtDay(dateOf(plan.start_date, day))}
            </h3>
            <div className="grid gap-3 lg:grid-cols-3">
              {list.map((it) => (
                <ItemCard key={it.id} it={it} plan={plan} onChange={patchLocal} onSendToSlides={onSendToSlides} />
              ))}
            </div>
          </section>
        ))}
        {!days.length && <p className="text-sm text-muted">Здесь пусто.</p>}
      </div>
    </div>
  );
}

// --- one carousel -----------------------------------------------------------------------------------
function ItemCard({
  it,
  plan,
  onChange,
  onSendToSlides,
}: {
  it: PlanItem;
  plan: ContentPlan;
  onChange: (it: PlanItem) => void;
  onSendToSlides?: (imp: SlidesImport) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/plans/items/${it.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.item) onChange(data.item);
    return data;
  }

  async function regenerate() {
    if (!confirm('Переписать эту карусель заново?')) return;
    setBusy('Переписываю…');
    try {
      const res = await fetch(`/api/plans/items/${it.id}/regenerate`, { method: 'POST' });
      const data = await res.json();
      if (data.item) onChange(data.item);
      else alert(data.error ?? 'Не получилось.');
    } finally {
      setBusy(null);
    }
  }

  function send() {
    onSendToSlides?.({
      id: `${it.id}-${Date.now()}`,
      title: `${it.account} · день ${it.day} · пост ${it.slot}`,
      texts: it.slides,
      planItemId: it.id,
    });
    if (it.status === 'draft') void patch({ status: 'in_slides' });
  }

  async function copyCaption() {
    await navigator.clipboard.writeText(it.caption ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!it.slides.length) {
    return (
      <div className="flex min-h-[160px] items-center justify-center rounded-xl border border-dashed border-edge bg-white p-4 text-xs text-muted">
        Пост {it.slot} · ещё пишется…
      </div>
    );
  }

  const ctaIdx = it.cta_variant ?? 0;
  const lastIsCta = it.slides[it.slides.length - 1] === plan.settings.cta_variants[ctaIdx];

  return (
    <div className="flex flex-col rounded-xl border border-edge bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-mono font-semibold">Пост {it.slot}</span>
        <span className={`rounded-full px-2 py-0.5 ${STATUS_CLS[it.status]}`}>{STATUS_LABEL[it.status]}</span>
        {it.rubric && <span className="rounded-full border border-edge px-2 py-0.5 text-muted">{it.rubric}</span>}
        {it.hook && <span className="rounded-full border border-edge px-2 py-0.5 text-muted">{it.hook}</span>}
        <span className="rounded-full border border-edge px-2 py-0.5 text-muted" title={plan.settings.cta_variants[ctaIdx]}>
          призыв {String.fromCharCode(65 + ctaIdx)}
        </span>
      </div>
      {it.title && <p className="mb-2 font-semibold leading-snug">{it.title}</p>}

      {editing ? (
        <div className="space-y-2">
          <span className={labelCls}>Слайды — пустая строка между слайдами</span>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} className={`${inputCls} h-auto py-2 text-sm`} />
          <span className={labelCls}>Подпись</span>
          <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} className={`${inputCls} h-auto py-2 text-sm`} />
          <div className="flex gap-3 text-sm">
            <button
              onClick={async () => {
                await patch({ slides: draft.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean), caption });
                setEditing(false);
              }}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
            >
              Сохранить
            </button>
            <button onClick={() => setEditing(false)} className="text-xs text-muted">
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <>
          <ol className="space-y-1 text-sm">
            {it.slides.map((s, i) => {
              const isCover = i === 0;
              const isCta = lastIsCta && i === it.slides.length - 1;
              return (
                <li key={i} className={`flex gap-2 ${isCover ? 'font-semibold' : ''} ${isCta ? 'italic text-muted' : ''}`}>
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted">{i + 1}</span>
                  <span className="whitespace-pre-line">{s}</span>
                </li>
              );
            })}
          </ol>
          {it.caption && (
            <div className="mt-3 rounded-lg bg-gray-50 p-2 text-xs">
              <span className="text-muted">Подпись: </span>
              {it.caption}
            </div>
          )}
        </>
      )}

      {!editing && (
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-3 text-xs">
          <button onClick={send} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white">
            → В Слайды
          </button>
          <button onClick={() => void copyCaption()} disabled={!it.caption} className="text-muted hover:text-gray-900">
            {copied ? 'Скопировано ✓' : 'Копировать подпись'}
          </button>
          <button
            onClick={() => {
              setDraft(it.slides.join('\n\n'));
              setCaption(it.caption ?? '');
              setEditing(true);
            }}
            className="text-muted hover:text-gray-900"
          >
            ✎ Править
          </button>
          <button onClick={() => void regenerate()} disabled={!!busy} className="text-muted hover:text-gray-900">
            {busy ?? '↻ Заново'}
          </button>
          <button
            onClick={() => void patch({ status: it.status === 'done' ? 'draft' : 'done' })}
            className="ml-auto text-muted hover:text-green-700"
          >
            {it.status === 'done' ? 'Снять «готово»' : '✓ Готово'}
          </button>
        </div>
      )}
    </div>
  );
}
