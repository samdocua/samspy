// SamSpy — MultiplyView («Размножение» tab)
//
// Up to 100 original photos (one folder) → N copies of each with small differences
// (camera angle, zoom, moment). Each copy = one /api/slides/generate call (Gemini
// direct or GPT Image via fal) with the base prompt from «Слайды» + its own variation.
// No text overlay. Optional auto pipeline: generate → Claude photo check against the
// original (+ GPT second opinion) → fix serious artifacts → re-check.
// Everything lives in this browser tab until reload; settings persist in localStorage.
//
// Version history:
//   v0.1.0 (2026-11-20) — upload / drag / Cmd+V, count 1–20, strength min/medium,
//                         3 copies in parallel with auto-retry, «Стоп», per-copy
//                         «Ещё раз» / download / delete, «+ Ещё N», full-size view,
//                         ZIP of all copies (metadata-free JPEGs), total cost.
//   v0.2.0 (2026-11-20) — AI check of every copy against the original (✓ / ! / ✕ badge,
//                         issue list); «Автопроверка и автоисправление»: serious (✕)
//                         artifacts → fixed by a fixed plan of max 4 steps per copy
//                         (fix ×2 main model → fix ×1 other model → regenerate from the
//                         original), never repeated automatically; versions with their
//                         checks, best one becomes current; per-copy «Проверить» /
//                         «Исправить» (also fixes «!»), «Проверить все».
//   v0.3.0 (2026-11-20) — second opinion: a copy Claude found clean also goes to GPT
//                         (provider 'openai'); its findings are prefixed «GPT:» and
//                         count like Claude's (✕ → auto-fix). «Проверили: …» line.
//   v0.4.0 (2026-11-20) — batch: whole folder (recursive, drag or picker) up to 100
//                         originals; copies grouped by original (collapsible rows);
//                         file names «<original name>_1.jpg, _2…»; flat ZIP of everything
//                         + ZIP per original; concurrency 1–5 (default 5); one queue for
//                         all originals; cost / time estimate with confirmation before big
//                         batches; progress bar; filter (all / ✕ / errors); warning before
//                         closing the tab while work is in progress.
//   v0.4.1 (2026-11-20) — toolbar: «Очистить всё» (photos + copies, asks to confirm when
//                         ready copies would be lost) and «Сбросить настройки».
//   v0.4.2 (2026-11-20) — inputs / selects one height (ctrlCls, h-10).
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { zipSync } from 'fflate';
import {
  ASPECT_RATIOS,
  EXPORT_SIZE,
  GPT_QUALITIES,
  IMAGE_MODELS,
  IMAGE_SIZES,
  altModelFor,
  findModel,
} from '@/lib/slides/config';
import { canvasToBlob, compressImage, loadImage, renderSlide } from '@/lib/slides/render';
import { pickSaveTarget, stamp } from '@/lib/slides/save';
import {
  MAX_CONCURRENCY,
  MAX_COUNT,
  MAX_ORIGINALS,
  MIN_COUNT,
  MULTIPLY_STORAGE_KEY,
  STRENGTHS,
  baseName,
  buildVariations,
  checkScore,
  copyPrompt,
  defaultsFromSlides,
  fixPrompt,
  sanitizeMultiply,
  slidesPrompt,
  uniqueName,
  type MultiplySettings,
  type PhotoCheck,
  type PhotoIssue,
} from '@/lib/multiply/config';
import { filesFromDrop, filesFromInput, isImage, type PickedFile } from '@/lib/multiply/files';

const GEN_RETRIES = 2;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const CHECK_SIDE = 768; // px, longest side of images sent to the check
const IMPORT_CONCURRENCY = 3;
const CONFIRM_ABOVE = 10; // ask before starting more generations than this
const DEFAULT_GEN_MS = 45_000; // time estimate before any generation finished
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 10);

interface Original {
  id: string;
  name: string; // unique base name used for the files: «IMG_4521» → IMG_4521_1.jpg
  path: string; // where it came from (relative path in the folder)
  source: string; // downscaled JPEG data URL (≤1600 px)
}

interface Version {
  image: string;
  label: string; // «Исходная», «Исправление 1», «Заново из оригинала»
  model: string;
  check: PhotoCheck | null;
}

interface Copy {
  id: string;
  originalId: string;
  variation: string;
  status: 'queued' | 'busy' | 'done' | 'error';
  phase: string | null; // what is running now: «Генерация…», «Проверка…», «Исправление 2/4…»
  image: string | null; // current version (JPEG data URL)
  error: string | null;
  ms: number | null; // time of the first generation
  costUsd: number | null; // sum over all generations of this copy (fixes included)
  costKind: 'tokens' | 'avg';
  versions: Version[];
  check: PhotoCheck | null; // check of the current version
  fixLog: string[];
  autoFixed: boolean; // the automatic fix plan already ran for this generation
}

function newCopy(originalId: string, variation: string): Copy {
  return {
    id: rid(),
    originalId,
    variation,
    status: 'queued',
    phase: null,
    image: null,
    error: null,
    ms: null,
    costUsd: null,
    costKind: 'tokens',
    versions: [],
    check: null,
    fixLog: [],
    autoFixed: false,
  };
}

interface PendingBatch {
  title: string;
  add: Copy[]; // new copies to create
  replaceOriginals: string[]; // originals whose current copies are removed first
  estCost: number | null;
  estMs: number;
}

type Filter = 'all' | 'fail' | 'error';

const CHECK_ICON: Record<PhotoCheck['status'], { icon: string; cls: string; title: string }> = {
  ok: { icon: '✓', cls: 'bg-green-600', title: 'Артефактов не найдено' },
  warn: { icon: '!', cls: 'bg-amber-500', title: 'Мелкие замечания' },
  fail: { icon: '✕', cls: 'bg-red-600', title: 'Заметные артефакты' },
};

/** Downscaled JPEG (longest side `max`) for the AI check — saves tokens. */
async function shrink(src: string, max = CHECK_SIDE): Promise<string> {
  const img = await loadImage(src);
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

function fmtDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

type GenOk = { ok: true; image: string; ms: number; costUsd: number | null; costKind: 'tokens' | 'avg'; model: string };
type GenResult = GenOk | { ok: false; error: string };

const labelCls = 'mb-1 block text-xs font-medium text-muted';
const inputCls =
  'w-full rounded-lg border border-edge bg-white px-3 py-2 text-sm outline-none focus:border-accent';
// inputs + selects: same fixed height (Safari draws number inputs taller than selects)
const ctrlCls = `${inputCls} h-10 py-0 leading-10`;
const btnCls = 'rounded-lg border border-edge bg-white px-4 py-2 text-sm font-medium disabled:opacity-40';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}

export default function MultiplyView({ visible = true }: { visible?: boolean }) {
  const [settings, setSettings] = useState<MultiplySettings | null>(null);
  const [originals, setOriginals] = useState<Original[]>([]);
  const [copies, setCopies] = useState<Copy[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [zipping, setZipping] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, setPending] = useState<PendingBatch | null>(null);
  const [priceHint, setPriceHint] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const copiesRef = useRef<Copy[]>([]);
  const originalsRef = useRef<Original[]>([]);
  const settingsRef = useRef<MultiplySettings | null>(null);
  const smallRefCache = useRef<Map<string, string>>(new Map());
  const stopRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // <input webkitdirectory> — not in React's typings, set it on the DOM node.
  useEffect(() => {
    folderRef.current?.setAttribute('webkitdirectory', '');
    folderRef.current?.setAttribute('directory', '');
  });

  // Load settings: saved «Размножение» settings, else the current «Слайды» ones.
  useEffect(() => {
    const d = defaultsFromSlides();
    let s = d;
    try {
      const raw = localStorage.getItem(MULTIPLY_STORAGE_KEY);
      if (raw) s = sanitizeMultiply(JSON.parse(raw), d);
    } catch {
      /* ignore broken storage */
    }
    setSettings(s);
  }, []);
  useEffect(() => {
    if (!settings) return;
    try {
      localStorage.setItem(MULTIPLY_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage full / disabled */
    }
  }, [settings]);

  // Price of one generation for the estimate (before real prices come in).
  const modelId = settings?.modelId;
  useEffect(() => {
    if (!modelId) return;
    let off = false;
    setPriceHint(null);
    fetch(`/api/slides/price?modelId=${encodeURIComponent(modelId)}`)
      .then((r) => r.json())
      .then((d) => !off && setPriceHint(typeof d?.costUsd === 'number' ? d.costUsd : null))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [modelId]);

  // Closing / reloading the tab loses everything — ask first.
  const hasWork = running || copies.some((c) => c.image);
  useEffect(() => {
    if (!hasWork) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [hasWork]);

  const set = <K extends keyof MultiplySettings>(k: K, v: MultiplySettings[K]) =>
    setSettings((s) => (s ? { ...s, [k]: v } : s));

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 10000);
  }, []);

  // Updates a copy; keeps copiesRef in sync right away for the async workers.
  const patch = useCallback((id: string, p: Partial<Copy>) => {
    copiesRef.current = copiesRef.current.map((c) => (c.id === id ? { ...c, ...p } : c));
    setCopies(copiesRef.current);
  }, []);

  const get = (id: string) => copiesRef.current.find((c) => c.id === id);
  const origOf = (c: Copy | undefined) => originalsRef.current.find((o) => o.id === c?.originalId);

  const log = (id: string, msg: string) => {
    const c = get(id);
    if (c) patch(id, { fixLog: [...c.fixLog, msg] });
  };

  const replaceCopies = (list: Copy[]) => {
    copiesRef.current = list;
    setCopies(list);
  };
  const replaceOriginals = (list: Original[]) => {
    originalsRef.current = list;
    setOriginals(list);
  };

  // --- adding originals -------------------------------------------------------------
  /** Adds photos (one, several or a whole folder) as new originals, up to MAX_ORIGINALS. */
  const addFiles = useCallback(
    async (picked: PickedFile[]) => {
      if (!picked.length) return;
      const images = picked.filter((p) => isImage(p.file));
      const skipped = picked.length - images.length;
      const room = MAX_ORIGINALS - originalsRef.current.length;
      const take = images.slice(0, Math.max(0, room));
      const over = images.length - take.length;
      const notes: string[] = [];
      if (!take.length) {
        flash(room <= 0 ? `Уже ${MAX_ORIGINALS} фото — больше нельзя.` : 'Среди файлов нет картинок.');
        return;
      }

      const taken = new Set(originalsRef.current.map((o) => o.name.toLowerCase()));
      const names = take.map((p) => uniqueName(baseName(p.file.name), taken));

      setImporting({ done: 0, total: take.length });
      const results: (Original | null)[] = new Array(take.length).fill(null);
      let failed = 0;
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < take.length) {
          const i = next++;
          try {
            results[i] = { id: rid(), name: names[i], path: take[i].path, source: await compressImage(take[i].file) };
          } catch {
            failed++;
          }
          setImporting({ done: ++done, total: take.length });
        }
      };
      await Promise.all(Array.from({ length: IMPORT_CONCURRENCY }, worker));
      setImporting(null);

      const added = results.filter((r): r is Original => !!r);
      replaceOriginals([...originalsRef.current, ...added]);
      notes.push(`Добавлено фото: ${added.length}`);
      if (skipped) notes.push(`пропущено не-картинок: ${skipped}`);
      if (failed) notes.push(`не открылись (HEIC и т.п.): ${failed}`);
      if (over) notes.push(`сверх лимита ${MAX_ORIGINALS}: ${over}`);
      flash(notes.join(' · '));
    },
    [flash]
  );

  // Cmd+V anywhere on the tab — only when the clipboard holds an image.
  useEffect(() => {
    if (!visible) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length) {
        e.preventDefault();
        void addFiles(files.map((file, i) => ({ file, path: file.name === 'image.png' ? `вставка-${i + 1}.png` : file.name })));
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles, visible]);

  function removeOriginal(id: string) {
    replaceCopies(copiesRef.current.filter((c) => c.originalId !== id));
    replaceOriginals(originalsRef.current.filter((o) => o.id !== id));
    smallRefCache.current.delete(id);
  }

  function clearAll() {
    setConfirmClear(false);
    setPending(null);
    replaceCopies([]);
    replaceOriginals([]);
    smallRefCache.current.clear();
    setCollapsed(new Set());
  }

  // --- API calls ----------------------------------------------------------------------
  /** One /api/slides/generate call with auto-retry on rate limit / server / network errors. */
  async function callGenerate(image: string, prompt: string, modelId: string): Promise<GenResult> {
    const s = settingsRef.current!;
    let lastErr = 'Неизвестная ошибка.';
    for (let attempt = 0; attempt <= GEN_RETRIES; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt + Math.random() * 1500);
      let retry = true;
      try {
        const res = await fetch('/api/slides/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image, prompt, modelId, aspect: s.aspect, size: s.size, quality: s.quality }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          return {
            ok: true,
            image: data.image,
            ms: data.ms,
            costUsd: data.costUsd ?? null,
            costKind: data.costKind === 'avg' ? 'avg' : 'tokens',
            model: data.model,
          };
        }
        retry = RETRYABLE.has(res.status);
        lastErr =
          data?.error ??
          (res.status === 413
            ? 'Картинка слишком большая для запроса.'
            : res.status === 504
              ? 'Генерация не уложилась по времени.'
              : res.status === 429
                ? 'Слишком много запросов к API (лимит).'
                : `Ошибка HTTP ${res.status}.`);
      } catch (e) {
        lastErr = `Сеть: ${(e as Error).message}`;
      }
      if (attempt > 0) lastErr += ` (попыток: ${attempt + 1})`;
      if (!retry) break;
    }
    return { ok: false, error: lastErr };
  }

  /** Cost bookkeeping: every generation of a copy (fixes too) adds to its total. */
  function addCost(c: Copy, r: GenOk): Partial<Copy> {
    return {
      costUsd: r.costUsd == null ? c.costUsd : (c.costUsd ?? 0) + r.costUsd,
      costKind: r.costKind === 'avg' || c.costKind === 'avg' ? 'avg' : 'tokens',
    };
  }

  /** Fresh generation of a copy from its original (starts a new version list). */
  async function generateCopy(id: string): Promise<boolean> {
    const s = settingsRef.current;
    const c = get(id);
    const orig = origOf(c);
    if (!s || !c || !orig) return false;
    patch(id, { status: 'busy', phase: 'Генерация…', error: null });
    const r = await callGenerate(orig.source, copyPrompt(s.prompt, c.variation, s.strength), s.modelId);
    if (!r.ok) {
      patch(id, { status: 'error', phase: null, error: r.error });
      return false;
    }
    patch(id, {
      status: 'done',
      phase: null,
      image: r.image,
      ms: r.ms,
      versions: [{ image: r.image, label: 'Исходная', model: r.model, check: null }],
      check: null,
      fixLog: [],
      autoFixed: false,
      ...addCost({ ...get(id)!, costUsd: null }, r),
    });
    return true;
  }

  /** Claude photo check of the copy's current version vs the original (+ GPT second opinion). */
  async function checkCopy(id: string): Promise<PhotoCheck | null> {
    const c = get(id);
    const orig = origOf(c);
    if (!c?.image) return null;
    const prevPhase = c.phase;
    patch(id, { phase: 'Проверка…' });
    const checkedImage = c.image;
    let check: PhotoCheck;
    try {
      let reference: string | undefined;
      if (orig) {
        reference = smallRefCache.current.get(orig.id);
        if (!reference) {
          reference = await shrink(orig.source);
          smallRefCache.current.set(orig.id, reference);
        }
      }
      const image = await shrink(checkedImage);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ask = async (provider: 'claude' | 'openai'): Promise<any> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let data: any = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await sleep(2500 * attempt);
          const res = await fetch('/api/slides/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'photo', image, reference, provider }),
          });
          data = await res.json().catch(() => null);
          if (res.ok) break;
          data = { error: data?.error ?? `HTTP ${res.status}` };
          if (!RETRYABLE.has(res.status)) break;
        }
        return data;
      };
      const norm = (list: PhotoIssue[], prefix = ''): PhotoIssue[] =>
        list.map((i) => ({
          type: i.type === 'photo_artifact' || i.type === 'scene_change' ? i.type : 'other',
          severity: i.severity === 'fail' ? 'fail' : 'warn',
          message: prefix + i.message,
        }));

      // 1) main check — Claude
      const main = await ask('claude');
      if (!main?.issues) {
        check = { status: 'warn', issues: [], error: main?.error ?? 'Проверка не ответила.', by: [], note: null };
      } else {
        const issues = norm(main.issues);
        const by = ['Claude'];
        let note: string | null = null;

        // 2) second opinion — GPT, only when Claude found nothing
        if (!issues.length) {
          const second = await ask('openai');
          if (second?.skipped) note = `GPT не проверял: ${second.reason ?? 'нет ключа'}`;
          else if (second?.issues) {
            by.push('GPT');
            issues.push(...norm(second.issues, 'GPT: '));
          } else note = `GPT не ответил: ${second?.error ?? 'неизвестно'}`;
        }
        const status = issues.some((i) => i.severity === 'fail') ? 'fail' : issues.length ? 'warn' : 'ok';
        check = { status, issues, error: null, by, note };
      }
    } catch (e) {
      check = { status: 'warn', issues: [], error: (e as Error).message, by: [], note: null };
    }
    const cur = get(id);
    patch(id, {
      phase: prevPhase === 'Проверка…' ? null : prevPhase,
      // the user may have switched versions meanwhile — attach the check to the right one
      ...(cur?.image === checkedImage ? { check } : {}),
      versions: (cur?.versions ?? []).map((v) => (v.image === checkedImage ? { ...v, check } : v)),
    });
    return check;
  }

  /** Problems the fix plan works on: serious ones (auto) or all of them (manual «Исправить»). */
  const toFix = (id: string, all: boolean) =>
    (get(id)?.check?.issues ?? []).filter((i) => all || i.severity === 'fail');

  /**
   * Check → fix plan. Fixed list of at most 4 steps, each runs once:
   *   1–2) edit the current copy with the main model, 3) edit with the other model,
   *   4) generate this copy again from the original (same variation).
   * Stops as soon as a check comes back clean (for the issues in scope), or on «Стоп».
   * The best version (fewest / mildest issues) becomes current. Nothing re-runs this
   * automatically afterwards (`autoFixed`) — only the user's «Исправить» / «Ещё раз».
   */
  async function checkAndFix(id: string, all = false): Promise<void> {
    const s = settingsRef.current;
    if (!s || !get(id)?.image) return;
    patch(id, { status: 'busy' });
    try {
      await checkCopy(id);
      if (!toFix(id, all).length) return;

      const main = findModel(s.modelId) ?? IMAGE_MODELS[0];
      const alt = altModelFor(main.id);
      const plan: { label: string; kind: 'fix' | 'regen'; modelId: string; name: string }[] = [
        { label: 'Исправление 1', kind: 'fix', modelId: main.id, name: main.label },
        { label: 'Исправление 2', kind: 'fix', modelId: main.id, name: main.label },
        { label: `Исправление (${alt.label})`, kind: 'fix', modelId: alt.id, name: alt.label },
        { label: 'Заново из оригинала', kind: 'regen', modelId: main.id, name: main.label },
      ];

      for (let k = 0; k < plan.length; k++) {
        const step = plan[k];
        if (stopRef.current) {
          log(id, 'Остановлено.');
          break;
        }
        const issues = toFix(id, all);
        if (!issues.length) break;
        const c = get(id)!;
        const orig = origOf(c);
        patch(id, { phase: `Исправление ${k + 1}/${plan.length}…` });
        log(id, `${step.label} (${step.name}): ${issues.map((i) => i.message).join('; ')}`);

        const r =
          step.kind === 'fix'
            ? await callGenerate(c.image!, fixPrompt(issues.map((i) => i.message)), step.modelId)
            : orig
              ? await callGenerate(orig.source, copyPrompt(s.prompt, c.variation, s.strength), step.modelId)
              : ({ ok: false, error: 'Нет оригинала.' } as const);
        if (!r.ok) {
          log(id, `${step.label}: генерация не удалась — ${r.error}`);
          continue;
        }
        const cur = get(id)!;
        patch(id, {
          image: r.image,
          check: null,
          versions: [...cur.versions, { image: r.image, label: step.label, model: r.model, check: null }],
          ...addCost(cur, r),
        });
        await checkCopy(id);
        if (!toFix(id, all).length) {
          log(id, `${step.label}: исправлено ✓`);
          break;
        }
      }

      // Best version becomes current (earlier wins a tie).
      const cur = get(id)!;
      if (cur.versions.length > 1) {
        const best = cur.versions.reduce((b, v) => (checkScore(v.check) < checkScore(b.check) ? v : b));
        if (best.image !== cur.image) patch(id, { image: best.image, check: best.check });
        if (toFix(id, all).length) {
          log(id, `Полностью не исправилось — выбрана лучшая версия: «${best.label}». Сравни версии.`);
        } else if (best.label !== 'Исходная') {
          log(id, `Текущая версия: «${best.label}».`);
        }
      }
    } finally {
      patch(id, { status: 'done', phase: null, autoFixed: true });
    }
  }

  // --- task runner ----------------------------------------------------------------------
  /** Runs `task` for the given copies, `concurrency` at a time; «Стоп» stops taking new ones. */
  async function runTasks(ids: string[], task: (id: string) => Promise<boolean | void>, label: string) {
    if (!ids.length || running) return;
    const conc = Math.min(settingsRef.current?.concurrency ?? 3, MAX_CONCURRENCY, ids.length);
    stopRef.current = false;
    setRunning(true);
    let next = 0;
    let failed = 0;
    let done = 0;
    setProgress({ done: 0, total: ids.length, label });
    const worker = async () => {
      while (next < ids.length && !stopRef.current) {
        const id = ids[next++];
        if (!get(id)) {
          done++;
          continue; // deleted meanwhile
        }
        if ((await task(id)) === false) failed++;
        done++;
        setProgress({ done, total: ids.length, label });
      }
    };
    try {
      await Promise.all(Array.from({ length: conc }, worker));
    } finally {
      setRunning(false);
      setProgress(null);
    }
    const sel = copiesRef.current.filter((c) => ids.includes(c.id));
    const st = sel.filter((c) => c.check && !c.check.error).map((c) => c.check!.status);
    const fixed = sel.filter((c) => c.versions.length > 1 && c.image !== c.versions[0].image).length;
    const parts = [`${label}: ${done - failed} из ${ids.length}`];
    if (failed) parts.push(`ошибок: ${failed}`);
    if (done < ids.length) parts.push(`остановлено, не запущено: ${ids.length - done}`);
    if (st.length) {
      parts.push(
        `проверка: ✓ ${st.filter((x) => x === 'ok').length} ! ${st.filter((x) => x === 'warn').length} ✕ ${st.filter((x) => x === 'fail').length}`
      );
    }
    if (fixed) parts.push(`исправлено: ${fixed}`);
    flash(parts.join(' · '));
  }

  /** Full pipeline for one copy: generate → (auto) check & fix. */
  const pipeline = async (id: string) => {
    const ok = await generateCopy(id);
    if (ok && settingsRef.current?.autoFix && !stopRef.current) await checkAndFix(id);
    return ok;
  };

  // --- batches (with estimate / confirmation) -----------------------------------------------
  /** Average real price / time of first generations in this tab (current model), else hints. */
  function estimate(n: number): { cost: number | null; ms: number } {
    const s = settingsRef.current!;
    const firsts = copiesRef.current.filter((c) => c.versions[0]?.model === s.modelId && c.ms != null);
    const priced = firsts.filter((c) => c.costUsd != null && c.versions.length === 1);
    const perCost = priced.length
      ? priced.reduce((a, c) => a + (c.costUsd ?? 0), 0) / priced.length
      : priceHint;
    const perMs = firsts.length ? firsts.reduce((a, c) => a + (c.ms ?? 0), 0) / firsts.length : DEFAULT_GEN_MS;
    const conc = Math.min(s.concurrency, n) || 1;
    return { cost: perCost == null ? null : perCost * n, ms: Math.ceil(n / conc) * perMs };
  }

  /** Builds a batch; small ones start right away, big ones wait for «Запустить». */
  function proposeBatch(title: string, targets: Original[], replace: boolean) {
    const s = settingsRef.current;
    if (!s || running || !targets.length) return;
    const add: Copy[] = [];
    for (const o of targets) {
      const used = replace ? [] : copiesRef.current.filter((c) => c.originalId === o.id).map((c) => c.variation);
      add.push(...buildVariations(s.count, s.strength, used).map((v) => newCopy(o.id, v)));
    }
    const est = estimate(add.length);
    const batch: PendingBatch = {
      title,
      add,
      replaceOriginals: replace ? targets.map((o) => o.id) : [],
      estCost: est.cost,
      estMs: est.ms,
    };
    if (add.length > CONFIRM_ABOVE) setPending(batch);
    else startBatch(batch);
  }

  function startBatch(b: PendingBatch) {
    setPending(null);
    const keep = copiesRef.current.filter((c) => !b.replaceOriginals.includes(c.originalId));
    // keep group order: each original's new copies go after its existing ones
    const order = originalsRef.current.map((o) => o.id);
    const merged = [...keep, ...b.add].sort(
      (a, c) => order.indexOf(a.originalId) - order.indexOf(c.originalId)
    );
    replaceCopies(merged);
    void runTasks(b.add.map((c) => c.id), pipeline, 'Готово');
  }

  const withoutCopies = originals.filter((o) => !copies.some((c) => c.originalId === o.id));
  const runNew = () => proposeBatch(`Размножить ${withoutCopies.length} фото`, withoutCopies, false);
  const runAllAgain = () => proposeBatch(`Размножить заново все ${originals.length} фото`, originals, true);
  const moreFor = (o: Original) => proposeBatch(`Ещё копии: ${o.name}`, [o], false);
  const againFor = (o: Original) => proposeBatch(`Заново: ${o.name}`, [o], true);

  const regenerateOne = (id: string) => void runTasks([id], pipeline, 'Готово');
  const checkOnly = async (x: string) => {
    patch(x, { status: 'busy' });
    await checkCopy(x);
    patch(x, { status: 'done' });
  };
  const checkOne = (id: string) => void runTasks([id], checkOnly, 'Проверено');
  const fixOne = (id: string) => void runTasks([id], (x) => checkAndFix(x, true), 'Исправление');

  function retryFailed() {
    void runTasks(copiesRef.current.filter((c) => c.status === 'error').map((c) => c.id), pipeline, 'Готово');
  }

  /** «Проверить все»: copies without a valid check; with auto-fix on, the fix plan runs once. */
  function checkAll() {
    const ids = copiesRef.current
      .filter((c) => c.image && c.status !== 'busy' && (!c.check || c.check.error))
      .map((c) => c.id);
    if (!ids.length) {
      flash('Все копии уже проверены.');
      return;
    }
    void runTasks(
      ids,
      async (x) => (settingsRef.current?.autoFix && !get(x)?.autoFixed ? checkAndFix(x) : checkOnly(x)),
      'Проверено'
    );
  }

  function selectVersion(id: string, v: Version) {
    patch(id, { image: v.image, check: v.check });
  }

  function removeCopy(id: string) {
    replaceCopies(copiesRef.current.filter((c) => c.id !== id));
    if (viewId === id) setViewId(null);
  }

  // --- naming + download -------------------------------------------------------------------
  const exp = settings ? EXPORT_SIZE[settings.aspect] : EXPORT_SIZE['3:4'];

  /** «<original>_<n>.jpg», n = position among this original's ready copies (no gaps). */
  function fileNameOf(c: Copy): string {
    const orig = originals.find((o) => o.id === c.originalId);
    const ready = copies.filter((x) => x.originalId === c.originalId && x.image);
    const n = ready.findIndex((x) => x.id === c.id) + 1;
    return `${orig?.name ?? 'copy'}_${n || '?'}.jpg`;
  }

  /** Final JPEG of a copy: export size of the format, no text, metadata stripped. */
  async function copyBlob(c: Copy): Promise<Blob> {
    const canvas = document.createElement('canvas');
    await renderSlide(canvas, c.image!, exp.w, exp.h, null);
    return canvasToBlob(canvas);
  }

  async function downloadCopy(c: Copy) {
    if (!c.image) return;
    const target = await pickSaveTarget(fileNameOf(c), 'image/jpeg', 'jpg');
    if (!target) return;
    await target.write(await copyBlob(c));
  }

  /** Flat ZIP (all files in the root) of the given ready copies. */
  async function downloadZip(list: Copy[], zipName: string) {
    const ready = list.filter((c) => c.image);
    if (!ready.length) return;
    const target = await pickSaveTarget(zipName, 'application/zip', 'zip');
    if (!target) return;
    try {
      const files: Record<string, [Uint8Array, { level: 0 }]> = {};
      for (let i = 0; i < ready.length; i++) {
        setZipping(`Собираю архив ${i + 1}/${ready.length}…`);
        const c = ready[i];
        files[fileNameOf(c)] = [new Uint8Array(await (await copyBlob(c)).arrayBuffer()), { level: 0 }];
      }
      setZipping('Упаковываю…');
      const zip = zipSync(files);
      await target.write(new Blob([zip as BlobPart], { type: 'application/zip' }));
      flash(`Архив: ${ready.length} файлов`);
    } catch (e) {
      flash(`Не удалось собрать архив: ${(e as Error).message}`);
    } finally {
      setZipping(null);
    }
  }

  if (!settings) return null;

  const model = findModel(settings.modelId) ?? IMAGE_MODELS[0];
  const readyCount = copies.filter((c) => c.image).length;
  const errorCount = copies.filter((c) => c.status === 'error').length;
  const failCount = copies.filter((c) => c.check?.status === 'fail' && !c.check.error).length;
  const uncheckedCount = copies.filter((c) => c.image && (!c.check || c.check.error)).length;
  const costs = copies.filter((c) => c.costUsd != null);
  const totalCost = costs.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const costApprox = costs.some((c) => c.costKind === 'avg');
  const viewed = copies.find((c) => c.id === viewId) ?? null;
  const shown = (c: Copy) =>
    filter === 'all' ||
    (filter === 'fail' && c.check?.status === 'fail' && !c.check.error) ||
    (filter === 'error' && c.status === 'error');

  const toggleGroup = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // --- copy card ----------------------------------------------------------------------------
  const card = (c: Copy) => {
    const busy = c.status === 'busy';
    return (
      <div key={c.id} className="group relative min-w-0">
        <div
          className="relative overflow-hidden rounded-xl border border-edge bg-white"
          style={{ aspectRatio: `${exp.w} / ${exp.h}` }}
        >
          {c.image ? (
            <button onClick={() => setViewId(c.id)} className="block h-full w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.image} alt="" loading="lazy" className="h-full w-full object-cover" />
            </button>
          ) : (
            <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted">
              {busy ? (
                c.phase ?? 'Генерация…'
              ) : c.status === 'error' ? (
                <span className="text-red-600">{c.error}</span>
              ) : running ? (
                'В очереди'
              ) : (
                'Не запущено'
              )}
            </div>
          )}
          {c.image && busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/70 px-2 text-center text-xs font-medium">
              {c.phase ?? 'Работаю…'}
            </div>
          )}
          {c.check && !c.check.error && !busy && (
            <span
              title={CHECK_ICON[c.check.status].title}
              className={`absolute bottom-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white ${CHECK_ICON[c.check.status].cls}`}
            >
              {CHECK_ICON[c.check.status].icon}
            </span>
          )}
          <button
            onClick={() => removeCopy(c.id)}
            disabled={busy}
            title="Удалить копию"
            className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-full border border-edge bg-white text-xs text-muted hover:text-gray-900 group-hover:flex disabled:hidden"
          >
            ×
          </button>
        </div>

        {c.image && <p className="mt-1 truncate text-[11px] font-medium">{fileNameOf(c)}</p>}

        {/* versions (original + fixes) */}
        {c.versions.length > 1 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {c.versions.map((v, k) => {
              const cur = v.image === c.image;
              const st = v.check && !v.check.error ? v.check.status : null;
              return (
                <button
                  key={k}
                  onClick={() => selectVersion(c.id, v)}
                  disabled={busy}
                  title={`${v.label}${st ? ` · ${CHECK_ICON[st].title}` : ''}`}
                  className={`relative h-10 w-8 overflow-hidden rounded border-2 ${cur ? 'border-accent' : 'border-edge'}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={v.image} alt="" loading="lazy" className="h-full w-full object-cover" />
                  {st && <span className={`absolute bottom-0 right-0 h-2 w-2 rounded-full ${CHECK_ICON[st].cls}`} />}
                </button>
              );
            })}
          </div>
        )}

        <p className="mt-1 line-clamp-2 text-[11px] text-muted" title={c.variation}>
          {c.variation}
        </p>

        {/* check results */}
        {c.check?.error && <p className="mt-1 text-[11px] text-amber-600">Проверка не удалась: {c.check.error}</p>}
        {c.check && !c.check.error && !busy && (
          <p className="mt-1 text-[11px] text-muted">
            Проверили: {c.check.by.join(' + ')}
            {c.check.note ? <span className="text-amber-600"> · {c.check.note}</span> : null}
          </p>
        )}
        {c.check && c.check.issues.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[11px]">
            {c.check.issues.map((it, k) => (
              <li key={k} className={it.severity === 'fail' ? 'text-red-600' : 'text-amber-600'}>
                {it.severity === 'fail' ? '✕' : '!'} {it.message}
              </li>
            ))}
          </ul>
        )}
        {c.fixLog.length > 0 && (
          <details className="mt-1 text-[11px] text-muted">
            <summary className="cursor-pointer">Исправления ({c.versions.length - 1})</summary>
            <ul className="mt-1 space-y-0.5">
              {c.fixLog.map((l, k) => (
                <li key={k}>{l}</li>
              ))}
            </ul>
          </details>
        )}

        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {c.image && (
            <button
              onClick={() => void downloadCopy(c)}
              disabled={busy}
              className="font-medium text-accent hover:underline disabled:opacity-40"
            >
              Скачать
            </button>
          )}
          {c.image && !busy && (
            <button onClick={() => checkOne(c.id)} disabled={running} className="text-muted hover:text-gray-900 disabled:opacity-40">
              Проверить
            </button>
          )}
          {c.image && !busy && (c.check?.issues.length ?? 0) > 0 && (
            <button
              onClick={() => fixOne(c.id)}
              disabled={running}
              title="Запустить исправление (до 4 шагов), включая мелкие замечания"
              className="text-muted hover:text-gray-900 disabled:opacity-40"
            >
              Исправить
            </button>
          )}
          {!busy && (c.image || c.status === 'error' || !running) && (
            <button
              onClick={() => regenerateOne(c.id)}
              disabled={running}
              className="text-muted hover:text-gray-900 disabled:opacity-40"
            >
              {c.image ? 'Ещё раз' : 'Сгенерировать'}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* toolbar + notice + progress */}
      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center justify-end gap-4 text-sm">
          {notice && <span className="mr-auto text-xs text-muted">{notice}</span>}
          {confirmClear ? (
            <span className="flex items-center gap-3 text-xs">
              <span className="text-red-600">Удалить все фото и {readyCount} готовых копий?</span>
              <button onClick={clearAll} className="rounded-lg bg-red-600 px-3 py-1 font-medium text-white">
                Удалить
              </button>
              <button onClick={() => setConfirmClear(false)} className="text-muted hover:text-gray-900">
                Отмена
              </button>
            </span>
          ) : (
            <button
              onClick={() => (readyCount > 0 ? setConfirmClear(true) : clearAll())}
              disabled={running || (!originals.length && !copies.length)}
              className="text-muted hover:text-red-600 disabled:opacity-40"
            >
              Очистить всё
            </button>
          )}
          <button
            onClick={() => {
              setSettings(defaultsFromSlides());
              flash('Настройки сброшены (по умолчанию — из «Слайдов»).');
            }}
            disabled={running}
            className="text-muted hover:text-gray-900 disabled:opacity-40"
          >
            Сбросить настройки
          </button>
        </div>
        {importing && (
          <p className="text-xs text-muted">
            Открываю фото: {importing.done} из {importing.total}…
          </p>
        )}
        {progress && (
          <div>
            <div className="mb-1 flex justify-between text-xs text-muted">
              <span>
                {progress.label === 'Готово' ? 'Генерация' : progress.label}: {progress.done} из {progress.total}
                {errorCount ? ` · ошибок: ${errorCount}` : ''}
              </span>
              <span>
                {(() => {
                  const left = progress.total - progress.done;
                  return left > 0 ? `осталось ≈ ${fmtDuration(estimate(left).ms)}` : '';
                })()}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-edge">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* confirmation of a big batch */}
      {pending && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent/5 px-4 py-3 text-sm">
          <span className="mr-auto">
            <b>{pending.title}</b>: {pending.add.length} генераций ·{' '}
            {pending.estCost != null ? `≈ $${pending.estCost.toFixed(2)}` : 'цена неизвестна'} (без учёта
            исправлений) · ≈ {fmtDuration(pending.estMs)}. Вкладку не закрывать.
            {pending.replaceOriginals.length > 0 && ' Текущие копии этих фото будут заменены.'}
          </span>
          <button onClick={() => startBatch(pending)} className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white">
            Запустить
          </button>
          <button onClick={() => setPending(null)} className="text-xs text-muted hover:text-gray-900">
            Отмена
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        {/* ---------------- left: originals + copies ---------------- */}
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">
              {originals.length ? `Фото: ${originals.length}` : 'Копии'}
              {copies.length ? ` · копии ${readyCount} из ${copies.length}` : ''}
            </h2>
            <span className="text-xs text-muted">
              {exp.w}×{exp.h} · JPEG
              {costs.length ? ` · ${costApprox ? '≈' : ''}$${totalCost.toFixed(2)}` : ''}
            </span>
          </div>

          {copies.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
              {(
                [
                  ['all', 'Все'],
                  ['fail', `С ✕ (${failCount})`],
                  ['error', `С ошибкой (${errorCount})`],
                ] as [Filter, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setFilter(id)}
                  className={`rounded-full px-3 py-1 ${
                    filter === id ? 'bg-accent text-white' : 'border border-edge bg-white text-muted hover:text-gray-900'
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto flex gap-3">
                <button onClick={() => setCollapsed(new Set(originals.map((o) => o.id)))} className="text-muted hover:text-gray-900">
                  Свернуть все
                </button>
                <button onClick={() => setCollapsed(new Set())} className="text-muted hover:text-gray-900">
                  Развернуть все
                </button>
              </span>
            </div>
          )}

          {originals.length === 0 ? (
            <div className="flex min-h-[320px] items-center justify-center rounded-xl border border-edge bg-white px-8 text-center">
              <div>
                <p className="font-medium">Здесь появятся копии.</p>
                <p className="mt-1 text-sm text-muted">
                  Добавь фото или целую папку справа (до {MAX_ORIGINALS}), выбери количество и нажми «Размножить».
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {originals.map((o) => {
                const group = copies.filter((c) => c.originalId === o.id);
                const visibleCopies = group.filter(shown);
                if (filter !== 'all' && !visibleCopies.length) return null;
                const isCollapsed = collapsed.has(o.id);
                const ready = group.filter((c) => c.image).length;
                const st = group.filter((c) => c.check && !c.check.error).map((c) => c.check!.status);
                const groupBusy = group.some((c) => c.status === 'busy');
                return (
                  <div key={o.id} className="rounded-xl border border-edge bg-white p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <button onClick={() => toggleGroup(o.id)} className="text-xs text-muted" title="Свернуть / развернуть">
                        {isCollapsed ? '▸' : '▾'}
                      </button>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={o.source} alt="" loading="lazy" className="h-14 w-11 rounded object-cover" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" title={o.path}>
                          {o.name}
                        </p>
                        <p className="text-xs text-muted">
                          {group.length ? `копии ${ready} из ${group.length}` : 'копий нет'}
                          {st.length
                            ? ` · ✓ ${st.filter((x) => x === 'ok').length} ! ${st.filter((x) => x === 'warn').length} ✕ ${st.filter((x) => x === 'fail').length}`
                            : ''}
                          {group.some((c) => c.status === 'error')
                            ? ` · ошибок: ${group.filter((c) => c.status === 'error').length}`
                            : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs">
                        {ready > 0 && (
                          <button
                            onClick={() => void downloadZip(group, `${o.name}.zip`)}
                            disabled={!!zipping}
                            className="font-medium text-accent hover:underline disabled:opacity-40"
                          >
                            ZIP ({ready})
                          </button>
                        )}
                        <button
                          onClick={() => moreFor(o)}
                          disabled={running}
                          className="text-muted hover:text-gray-900 disabled:opacity-40"
                        >
                          {group.length ? `+ Ещё ${settings.count}` : `Размножить (${settings.count})`}
                        </button>
                        {group.length > 0 && (
                          <button
                            onClick={() => againFor(o)}
                            disabled={running}
                            className="text-muted hover:text-gray-900 disabled:opacity-40"
                          >
                            Заново
                          </button>
                        )}
                        <button
                          onClick={() => removeOriginal(o.id)}
                          disabled={running || groupBusy}
                          title="Убрать фото и его копии"
                          className="text-muted hover:text-red-600 disabled:opacity-40"
                        >
                          Убрать
                        </button>
                      </div>
                    </div>
                    {!isCollapsed && visibleCopies.length > 0 && (
                      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 xl:grid-cols-5">
                        {visibleCopies.map(card)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {copies.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {readyCount > 0 && (
                <button
                  onClick={() => void downloadZip(copies, `copies_${stamp()}.zip`)}
                  disabled={!!zipping}
                  className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {zipping ?? `Скачать все (${readyCount}) · ZIP`}
                </button>
              )}
              {uncheckedCount > 0 && !running && (
                <button onClick={checkAll} className={btnCls}>
                  Проверить все ({uncheckedCount})
                </button>
              )}
              {errorCount > 0 && !running && (
                <button onClick={retryFailed} className={btnCls}>
                  Повторить с ошибкой ({errorCount})
                </button>
              )}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            Всё живёт в этой вкладке до перезагрузки — не закрывай её, пока идёт генерация. Настройки сохраняются.
          </p>
        </section>

        {/* ---------------- right: settings ---------------- */}
        <aside className="space-y-5 self-start rounded-xl border border-edge bg-white p-5 lg:sticky lg:top-4">
          <div>
            <span className={labelCls}>
              Фото {originals.length ? `(${originals.length} из ${MAX_ORIGINALS})` : `(до ${MAX_ORIGINALS})`}
            </span>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void filesFromDrop(e.dataTransfer).then(addFiles);
              }}
              className={`rounded-lg border-2 border-dashed p-3 text-sm transition ${
                dragOver ? 'border-accent bg-accent/5' : 'border-edge'
              }`}
            >
              <p className="font-medium">Перетащи сюда папку или фото</p>
              <p className="text-muted">или вставь из буфера (Cmd+V)</p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => folderRef.current?.click()}
                  disabled={!!importing}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                >
                  Выбрать папку
                </button>
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={!!importing}
                  className="rounded-lg border border-edge bg-white px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                >
                  Выбрать файлы
                </button>
              </div>
              <p className="mt-2 text-xs text-muted">
                JPEG, PNG, WebP · вложенные папки тоже · имена копий: «имя-файла_1.jpg, _2…»
              </p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(filesFromInput(e.target.files));
                e.target.value = '';
              }}
            />
            <input
              ref={folderRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(filesFromInput(e.target.files));
                e.target.value = '';
              }}
            />
          </div>

          <div className="space-y-3 border-t border-edge pt-5">
            <div className="grid grid-cols-3 gap-2">
              <Field label="Копий на фото">
                <input
                  type="number"
                  min={MIN_COUNT}
                  max={MAX_COUNT}
                  value={settings.count}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    set('count', Number.isFinite(n) ? Math.min(MAX_COUNT, Math.max(MIN_COUNT, n)) : MIN_COUNT);
                  }}
                  className={ctrlCls}
                />
              </Field>
              <Field label="Изменения">
                <select
                  value={settings.strength}
                  onChange={(e) => set('strength', e.target.value as MultiplySettings['strength'])}
                  className={ctrlCls}
                >
                  {STRENGTHS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Параллельно">
                <select
                  value={settings.concurrency}
                  onChange={(e) => set('concurrency', Number(e.target.value))}
                  className={ctrlCls}
                >
                  {Array.from({ length: MAX_CONCURRENCY }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Промпт">
              <textarea
                value={settings.prompt}
                onChange={(e) => set('prompt', e.target.value)}
                rows={6}
                className={`${inputCls} resize-y`}
              />
            </Field>
            <div className="-mt-1 flex justify-between text-xs">
              <span className="text-muted">К промпту каждой копии добавляется своё небольшое изменение.</span>
              <button
                onClick={() => {
                  set('prompt', slidesPrompt());
                  flash('Промпт взят из «Слайдов».');
                }}
                className="shrink-0 pl-2 text-muted hover:text-gray-900"
              >
                Взять из «Слайдов»
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Field label="Модель">
                <select value={settings.modelId} onChange={(e) => set('modelId', e.target.value)} className={ctrlCls}>
                  {IMAGE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Формат">
                <select
                  value={settings.aspect}
                  onChange={(e) => set('aspect', e.target.value as MultiplySettings['aspect'])}
                  className={ctrlCls}
                >
                  {ASPECT_RATIOS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Размер">
                <select
                  value={settings.size}
                  onChange={(e) => set('size', e.target.value as MultiplySettings['size'])}
                  className={ctrlCls}
                >
                  {IMAGE_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {model.provider === 'fal' && (
              <Field label="Качество (GPT Image)">
                <select
                  value={settings.quality}
                  onChange={(e) => set('quality', e.target.value as MultiplySettings['quality'])}
                  className={ctrlCls}
                >
                  {GPT_QUALITIES.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.autoFix}
                onChange={(e) => set('autoFix', e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Автопроверка и автоисправление
                <span className="block text-xs text-muted">
                  Claude сравнивает каждую копию с оригиналом; если он ничего не нашёл — второе мнение от GPT.
                  Заметные артефакты (✕) исправляются максимум за 4 шага: 2× основной моделью, 1× другой,
                  1× заново из оригинала — один раз, без повторов. Мелкие (!) только показываются.
                </span>
              </span>
            </label>
          </div>

          <div className="space-y-2 border-t border-edge pt-5">
            {running ? (
              <button
                onClick={() => {
                  stopRef.current = true;
                  flash('Останавливаю: текущие шаги допишутся, новые не начнутся.');
                }}
                className="w-full rounded-lg border border-edge bg-white px-5 py-2.5 text-sm font-medium"
              >
                Стоп
              </button>
            ) : (
              <>
                {withoutCopies.length > 0 && (
                  <button
                    onClick={runNew}
                    disabled={!!importing}
                    className="w-full rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
                  >
                    Размножить: {withoutCopies.length} фото × {settings.count} ={' '}
                    {withoutCopies.length * settings.count}
                  </button>
                )}
                {originals.length > 0 && copies.length > 0 && (
                  <button onClick={runAllAgain} disabled={!!importing} className={`w-full ${btnCls}`}>
                    Размножить заново все ({originals.length} × {settings.count})
                  </button>
                )}
                {originals.length === 0 && (
                  <button
                    disabled
                    className="w-full rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white opacity-40"
                  >
                    Размножить
                  </button>
                )}
              </>
            )}
            <p className="text-xs text-muted">
              Одна очередь на все фото, по {settings.concurrency} одновременно; сбои API повторяются
              автоматически. Перед большим запуском — оценка цены и времени.
            </p>
          </div>
        </aside>
      </div>

      {/* full-size view */}
      {viewed?.image && (
        <div onClick={() => setViewId(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewed.image} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </div>
  );
}
