// SamSpy — MultiplyView («Размножение» tab)
//
// One reference photo → N copies with small differences (camera angle, zoom,
// moment). Each copy = one /api/slides/generate call (Gemini direct or GPT Image
// via fal) with the base prompt from «Слайды» + its own variation. No text overlay.
// Optional auto pipeline: generate → Claude photo check (/api/slides/check, mode
// 'photo', compared with the original) → fix serious artifacts → re-check.
// Images live in memory until reload; settings persist in localStorage.
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
  MAX_COUNT,
  MIN_COUNT,
  MULTIPLY_STORAGE_KEY,
  STRENGTHS,
  buildVariations,
  checkScore,
  copyPrompt,
  defaultsFromSlides,
  fixPrompt,
  sanitizeMultiply,
  slidesPrompt,
  type MultiplySettings,
  type PhotoCheck,
  type PhotoIssue,
} from '@/lib/multiply/config';

const GEN_CONCURRENCY = 3;
const GEN_RETRIES = 2;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const CHECK_SIDE = 768; // px, longest side of images sent to the check
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n: number) => String(n).padStart(2, '0');

interface Version {
  image: string;
  label: string; // «Исходная», «Исправление 1», «Заново из оригинала»
  model: string;
  check: PhotoCheck | null;
}

interface Copy {
  id: string;
  variation: string;
  status: 'queued' | 'busy' | 'done' | 'error';
  phase: string | null; // what is running now: «Генерация…», «Проверка…», «Исправление 2/4…»
  image: string | null; // current version (JPEG data URL)
  error: string | null;
  ms: number | null;
  costUsd: number | null; // sum over all generations of this copy (fixes included)
  costKind: 'tokens' | 'avg';
  versions: Version[];
  check: PhotoCheck | null; // check of the current version
  fixLog: string[];
  autoFixed: boolean; // the automatic fix plan already ran for this generation
}

function newCopy(variation: string): Copy {
  return {
    id: Math.random().toString(36).slice(2, 10),
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

type GenOk = { ok: true; image: string; ms: number; costUsd: number | null; costKind: 'tokens' | 'avg'; model: string };
type GenResult = GenOk | { ok: false; error: string };

const labelCls = 'mb-1 block text-xs font-medium text-muted';
const inputCls =
  'w-full rounded-lg border border-edge bg-white px-3 py-2 text-sm outline-none focus:border-accent';

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
  const [source, setSource] = useState<string | null>(null);
  const [copies, setCopies] = useState<Copy[]>([]);
  const [running, setRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);

  const copiesRef = useRef<Copy[]>([]);
  const settingsRef = useRef<MultiplySettings | null>(null);
  const sourceRef = useRef<string | null>(null);
  const smallRefCache = useRef<{ src: string; small: string } | null>(null);
  const stopRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

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

  const set = <K extends keyof MultiplySettings>(k: K, v: MultiplySettings[K]) =>
    setSettings((s) => (s ? { ...s, [k]: v } : s));

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 8000);
  }, []);

  // Updates a copy; keeps copiesRef in sync right away for the async workers.
  const patch = useCallback((id: string, p: Partial<Copy>) => {
    copiesRef.current = copiesRef.current.map((c) => (c.id === id ? { ...c, ...p } : c));
    setCopies(copiesRef.current);
  }, []);

  const get = (id: string) => copiesRef.current.find((c) => c.id === id);

  const log = (id: string, msg: string) => {
    const c = get(id);
    if (c) patch(id, { fixLog: [...c.fixLog, msg] });
  };

  const replaceCopies = (list: Copy[]) => {
    copiesRef.current = list;
    setCopies(list);
  };

  // --- reference photo ------------------------------------------------------------
  const handleFiles = useCallback(
    async (list: FileList | File[] | null | undefined) => {
      const files = Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
      if (!files.length) {
        flash('Это не картинка.');
        return;
      }
      if (files.length > 1) flash('Берётся одно фото — первое из выбранных.');
      try {
        setSource(await compressImage(files[0]));
      } catch (e) {
        flash(`Не удалось открыть фото: ${(e as Error).message}`);
      }
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
        void handleFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFiles, visible]);

  // --- API calls ----------------------------------------------------------------------
  /** One /api/slides/generate call with auto-retry on rate limit / server / network errors. */
  async function callGenerate(image: string, prompt: string, modelId: string): Promise<GenResult> {
    const s = settingsRef.current!;
    let lastErr = 'Неизвестная ошибка.';
    for (let attempt = 0; attempt <= GEN_RETRIES; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt);
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
      ms: r.ms,
      costUsd: r.costUsd == null ? c.costUsd : (c.costUsd ?? 0) + r.costUsd,
      costKind: r.costKind === 'avg' || c.costKind === 'avg' ? 'avg' : 'tokens',
    };
  }

  /** Fresh generation of a copy from the original (starts a new version list). */
  async function generateCopy(id: string): Promise<boolean> {
    const s = settingsRef.current;
    const src = sourceRef.current;
    const c = get(id);
    if (!s || !src || !c) return false;
    patch(id, { status: 'busy', phase: 'Генерация…', error: null });
    const r = await callGenerate(src, copyPrompt(s.prompt, c.variation, s.strength), s.modelId);
    if (!r.ok) {
      patch(id, { status: 'error', phase: null, error: r.error });
      return false;
    }
    patch(id, {
      status: 'done',
      phase: null,
      image: r.image,
      versions: [{ image: r.image, label: 'Исходная', model: r.model, check: null }],
      check: null,
      fixLog: [],
      autoFixed: false,
      costUsd: null,
      ...addCost({ ...get(id)!, costUsd: null }, r),
    });
    return true;
  }

  /** Claude photo check of the copy's current version, compared with the original. */
  async function checkCopy(id: string): Promise<PhotoCheck | null> {
    const c = get(id);
    const src = sourceRef.current;
    if (!c?.image) return null;
    const prevPhase = c.phase;
    patch(id, { phase: 'Проверка…' });
    const checkedImage = c.image;
    let check: PhotoCheck;
    try {
      let reference: string | undefined;
      if (src) {
        if (smallRefCache.current?.src !== src) {
          smallRefCache.current = { src, small: await shrink(src) };
        }
        reference = smallRefCache.current.small;
      }
      const image = await shrink(checkedImage);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ask = async (provider: 'claude' | 'openai'): Promise<any> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let data: any = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt) await sleep(2500);
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
        const src = sourceRef.current;
        patch(id, { phase: `Исправление ${k + 1}/${plan.length}…` });
        log(id, `${step.label} (${step.name}): ${issues.map((i) => i.message).join('; ')}`);

        const r =
          step.kind === 'fix'
            ? await callGenerate(c.image!, fixPrompt(issues.map((i) => i.message)), step.modelId)
            : src
              ? await callGenerate(src, copyPrompt(s.prompt, c.variation, s.strength), step.modelId)
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
  /** Runs `task` for the given copies, GEN_CONCURRENCY at a time; «Стоп» stops taking new ones. */
  async function runTasks(ids: string[], task: (id: string) => Promise<boolean | void>, label: string) {
    if (!ids.length || running) return;
    stopRef.current = false;
    setRunning(true);
    let next = 0;
    let failed = 0;
    let done = 0;
    const worker = async () => {
      while (next < ids.length && !stopRef.current) {
        const id = ids[next++];
        if ((await task(id)) === false) failed++;
        done++;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(GEN_CONCURRENCY, ids.length) }, worker));
    } finally {
      setRunning(false);
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

  /** New batch: replaces the current copies. */
  function startNew() {
    const s = settingsRef.current;
    if (!s || !source || running) return;
    const list = buildVariations(s.count, s.strength).map(newCopy);
    replaceCopies(list);
    void runTasks(list.map((c) => c.id), pipeline, 'Готово');
  }

  /** «+ Ещё N»: appends copies with variations not used yet. */
  function addMore() {
    const s = settingsRef.current;
    if (!s || !source || running) return;
    const used = copiesRef.current.map((c) => c.variation);
    const list = buildVariations(s.count, s.strength, used).map(newCopy);
    replaceCopies([...copiesRef.current, ...list]);
    void runTasks(list.map((c) => c.id), pipeline, 'Готово');
  }

  const regenerateOne = (id: string) => void runTasks([id], pipeline, 'Готово');
  const checkOne = (id: string) =>
    void runTasks([id], async (x) => {
      patch(x, { status: 'busy' });
      await checkCopy(x);
      patch(x, { status: 'done' });
    }, 'Проверено');
  const fixOne = (id: string) => void runTasks([id], (x) => checkAndFix(x, true), 'Исправление');

  function retryFailed() {
    void runTasks(copiesRef.current.filter((c) => c.status === 'error').map((c) => c.id), pipeline, 'Готово');
  }

  /**
   * «Проверить все»: copies with an image and no valid check. With auto-fix on, a copy
   * whose fix plan has not run yet goes through it; others are only checked.
   */
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
      async (x) => {
        if (settingsRef.current?.autoFix && !get(x)?.autoFixed) return checkAndFix(x);
        patch(x, { status: 'busy' });
        await checkCopy(x);
        patch(x, { status: 'done' });
      },
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

  // --- download --------------------------------------------------------------------
  const exp = settings ? EXPORT_SIZE[settings.aspect] : EXPORT_SIZE['3:4'];

  /** Final JPEG of a copy: export size of the format, no text, metadata stripped. */
  async function copyBlob(c: Copy): Promise<Blob> {
    const canvas = document.createElement('canvas');
    await renderSlide(canvas, c.image!, exp.w, exp.h, null);
    return canvasToBlob(canvas);
  }

  async function downloadCopy(c: Copy, index: number) {
    if (!c.image) return;
    const target = await pickSaveTarget(`copy-${pad2(index + 1)}.jpg`, 'image/jpeg', 'jpg');
    if (!target) return;
    await target.write(await copyBlob(c));
  }

  async function downloadAll() {
    const ready = copies.map((c, i) => ({ c, i })).filter(({ c }) => c.image);
    if (!ready.length) return;
    const target = await pickSaveTarget(`copies_${stamp()}.zip`, 'application/zip', 'zip');
    if (!target) return;
    setZipping(true);
    try {
      const files: Record<string, [Uint8Array, { level: 0 }]> = {};
      for (const { c, i } of ready) {
        files[`copy-${pad2(i + 1)}.jpg`] = [new Uint8Array(await (await copyBlob(c)).arrayBuffer()), { level: 0 }];
      }
      const zip = zipSync(files);
      await target.write(new Blob([zip as BlobPart], { type: 'application/zip' }));
      flash(`Архив: ${ready.length} копий`);
    } catch (e) {
      flash(`Не удалось собрать архив: ${(e as Error).message}`);
    } finally {
      setZipping(false);
    }
  }

  if (!settings) return null;

  const model = findModel(settings.modelId) ?? IMAGE_MODELS[0];
  const readyCount = copies.filter((c) => c.image).length;
  const errorCount = copies.filter((c) => c.status === 'error').length;
  const uncheckedCount = copies.filter((c) => c.image && (!c.check || c.check.error)).length;
  const costs = copies.filter((c) => c.costUsd != null);
  const totalCost = costs.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const costApprox = costs.some((c) => c.costKind === 'avg');
  const viewed = copies.find((c) => c.id === viewId) ?? null;

  return (
    <div>
      {/* toolbar */}
      <div className="mb-4 flex min-h-[20px] flex-wrap items-center gap-4 text-sm">
        {notice && <span className="mr-auto text-xs text-muted">{notice}</span>}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        {/* ---------------- left: copies ---------------- */}
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-4">
            <h2 className="text-base font-semibold">
              Копии{copies.length ? ` · ${readyCount} из ${copies.length}` : ''}
            </h2>
            <span className="text-xs text-muted">
              {exp.w}×{exp.h} · JPEG
              {costs.length ? ` · ${costApprox ? '≈' : ''}$${totalCost.toFixed(3)}` : ''}
            </span>
          </div>

          {copies.length === 0 ? (
            <div className="flex min-h-[320px] items-center justify-center rounded-xl border border-edge bg-white px-8 text-center">
              <div>
                <p className="font-medium">Здесь появятся копии.</p>
                <p className="mt-1 text-sm text-muted">
                  Добавь фото справа, выбери количество и нажми «Размножить».
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 xl:grid-cols-4">
              {copies.map((c, i) => {
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
                          <img src={c.image} alt="" className="h-full w-full object-cover" />
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
                      <span className="absolute left-1.5 top-1.5 rounded bg-gray-900/80 px-1.5 text-[11px] font-semibold text-white">
                        {pad2(i + 1)}
                      </span>
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

                    {/* versions (original + fixes) */}
                    {c.versions.length > 1 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {c.versions.map((v, k) => {
                          const cur = v.image === c.image;
                          const st = v.check && !v.check.error ? v.check.status : null;
                          return (
                            <button
                              key={k}
                              onClick={() => selectVersion(c.id, v)}
                              disabled={busy}
                              title={`${v.label}${st ? ` · ${CHECK_ICON[st].title}` : ''}`}
                              className={`relative h-10 w-8 overflow-hidden rounded border-2 ${
                                cur ? 'border-accent' : 'border-edge'
                              }`}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={v.image} alt="" className="h-full w-full object-cover" />
                              {st && (
                                <span
                                  className={`absolute bottom-0 right-0 h-2 w-2 rounded-full ${CHECK_ICON[st].cls}`}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <p className="mt-1 line-clamp-2 text-[11px] text-muted" title={c.variation}>
                      {c.variation}
                    </p>

                    {/* check results */}
                    {c.check?.error && (
                      <p className="mt-1 text-[11px] text-amber-600">Проверка не удалась: {c.check.error}</p>
                    )}
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
                          onClick={() => void downloadCopy(c, i)}
                          disabled={busy}
                          className="font-medium text-accent hover:underline disabled:opacity-40"
                        >
                          Скачать
                        </button>
                      )}
                      {c.image && !busy && (
                        <button
                          onClick={() => checkOne(c.id)}
                          disabled={running}
                          className="text-muted hover:text-gray-900 disabled:opacity-40"
                        >
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
              })}
            </div>
          )}

          {copies.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {readyCount > 0 && (
                <button
                  onClick={() => void downloadAll()}
                  disabled={zipping || running}
                  className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {zipping ? 'Собираю архив…' : `Скачать все (${readyCount}) · ZIP`}
                </button>
              )}
              {uncheckedCount > 0 && !running && (
                <button
                  onClick={checkAll}
                  className="rounded-lg border border-edge bg-white px-5 py-2 text-sm font-medium"
                >
                  Проверить все ({uncheckedCount})
                </button>
              )}
              {errorCount > 0 && !running && (
                <button
                  onClick={retryFailed}
                  className="rounded-lg border border-edge bg-white px-5 py-2 text-sm font-medium"
                >
                  Повторить с ошибкой ({errorCount})
                </button>
              )}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            Картинки живут до перезагрузки страницы. Настройки сохраняются.
          </p>
        </section>

        {/* ---------------- right: settings ---------------- */}
        <aside className="space-y-5 rounded-xl border border-edge bg-white p-5">
          <div>
            <span className={labelCls}>Фото</span>
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void handleFiles(e.dataTransfer.files);
              }}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed p-3 text-sm transition ${
                dragOver ? 'border-accent bg-accent/5' : 'border-edge'
              }`}
            >
              {source ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={source} alt="" className="h-20 w-16 rounded object-cover" />
              ) : null}
              <div className="text-muted">
                <p className="font-medium text-gray-900">
                  {source ? 'Заменить фото' : 'Перетащи фото сюда'}
                </p>
                <p>или вставь из буфера (Cmd+V), или нажми, чтобы выбрать</p>
                <p className="text-xs">JPEG, PNG, WebP · одно фото</p>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          <div className="space-y-3 border-t border-edge pt-5">
            <div className="grid grid-cols-2 gap-2">
              <Field label={`Количество копий (${MIN_COUNT}–${MAX_COUNT})`}>
                <input
                  type="number"
                  min={MIN_COUNT}
                  max={MAX_COUNT}
                  value={settings.count}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    set('count', Number.isFinite(n) ? Math.min(MAX_COUNT, Math.max(MIN_COUNT, n)) : MIN_COUNT);
                  }}
                  className={inputCls}
                />
              </Field>
              <Field label="Сила изменений">
                <select
                  value={settings.strength}
                  onChange={(e) => set('strength', e.target.value as MultiplySettings['strength'])}
                  className={inputCls}
                >
                  {STRENGTHS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Промпт">
              <textarea
                value={settings.prompt}
                onChange={(e) => set('prompt', e.target.value)}
                rows={7}
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
                <select
                  value={settings.modelId}
                  onChange={(e) => set('modelId', e.target.value)}
                  className={inputCls}
                >
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
                  className={inputCls}
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
                  className={inputCls}
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
                  className={inputCls}
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
                  Claude сравнивает каждую копию с оригиналом; если он ничего не нашёл — второе мнение от GPT. Заметные артефакты (✕) исправляются
                  максимум за 4 шага: 2× основной моделью, 1× другой, 1× заново из оригинала —
                  один раз, без повторов. Мелкие (!) только показываются.
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
                <button
                  onClick={startNew}
                  disabled={!source}
                  className="w-full rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
                >
                  {copies.length ? `Размножить заново (${settings.count})` : `Размножить (${settings.count})`}
                </button>
                {copies.length > 0 && (
                  <button
                    onClick={addMore}
                    disabled={!source}
                    className="w-full rounded-lg border border-edge bg-white px-5 py-2 text-sm font-medium disabled:opacity-40"
                  >
                    + Ещё {settings.count} к текущим
                  </button>
                )}
              </>
            )}
            <p className="text-xs text-muted">
              Генерируются по {GEN_CONCURRENCY} одновременно, сбои API повторяются автоматически.
              «Размножить заново» заменяет текущие копии.
            </p>
          </div>
        </aside>
      </div>

      {/* full-size view */}
      {viewed?.image && (
        <div
          onClick={() => setViewId(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewed.image} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </div>
  );
}
