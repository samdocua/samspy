// SamSpy — SlidesView («Слайды» tab)
//
// Pipeline per slide: reference photo (upload / drag / Cmd+V) → AI regenerate
// (Gemini direct or GPT Image via fal, /api/slides/generate) → text overlay on canvas →
// download JPEG. Images live in memory until reload; settings persist in
// localStorage and can be exported / imported as JSON.
//
// Version history:
//   v0.1.0 (2026-11-18) — slide strip, per-slide text, generate / generate all,
//                         live text preview, JPEG download, settings export/import.
//   v0.2.0 (2026-11-18) — GPT Image models via fal: quality picker for them;
//                         status line shows cost/tokens only when known.
//   v0.3.0 (2026-11-18) — fal: shows ≈ average price per call (costKind 'avg').
//   v0.4.0 (2026-11-18) — loads TikTok Sans (500/700) for the text overlay.
//   v0.4.1 (2026-11-18) — TikTok Sans 600 too; preview on the reference is no
//                         longer faded (it washed the text out) — badge instead.
//   v0.5.0 (2026-11-18) — fonts for Instagram A/B styles (Instrument Sans,
//                         Gabarito, Montserrat).
//   v0.6.0 (2026-11-19) — fonts Cormorant / Oswald / Instrument Sans 700;
//                         «Наклон, °» and «Подзаголовок, %» fields.
//   v0.7.0 (2026-11-19) — multi-file upload (picker / drag / Cmd+V, also onto the
//                         slide strip): 1 file → current slide; several → current
//                         slide if empty, rest → new slides; natural name order;
//                         max 20 per batch; non-images skipped with a notice.
//   v0.8.0 (2026-11-19) — «Сгенерировать все» runs 3 slides in parallel with auto-retry
//                         (429/5xx/network, up to 2 retries); errors panel with
//                         per-slide «Повторить» + «Повторить все с ошибкой»;
//                         one text field per slide (count follows the slides).
//   v0.9.0 (2026-11-19) — `incoming` texts from «Карусели» (fill if empty, else a banner
//                         Заменить / Добавить в конец / Отмена); several photos now
//                         fill slides without a photo first (strip order), extras → new.
//   v0.10.0 (2026-11-19) — «Проверить»: instant local checks (overflow, readability on
//                          bright background, text garbage) + AI check of the rendered
//                          slide (/api/slides/check); ✓/⚠/✗ badges, «Проверка» panel;
//                          a check is invalidated when the photo, text or style changes.
//   v0.10.1 (2026-11-19) — text style settings above the per-slide text fields.
//   v0.10.2 (2026-11-19) — right panel order: reference → prompt/model → text
//                          settings → slide texts → generate / check / errors.
//   v0.10.3 (2026-11-19) — no divider between model settings and text settings.
//   v0.11.0 (2026-11-19) — full auto pipeline (setting «Автопроверка и автоисправление»):
//                          generate → check → if photo artifacts: edit the current image
//                          with a targeted fix prompt → re-check, max 2 attempts;
//                          fix log per slide, «Вернуть исходную»; patch() keeps
//                          slidesRef in sync immediately.
//   v0.12.0 (2026-11-19) — slide versions (original + every fix) with their checks;
//                          escalation: after 2 failed fixes one try with the other model
//                          (GPT Image ↔ Gemini); best version picked by check score;
//                          version thumbnails to compare / switch; replaces «Вернуть исходную».
//   v0.12.1 (2026-11-19) — second opinion: after a clean Claude check the slide also goes
//                          to GPT (provider 'openai'); its findings are prefixed «GPT:».
//   v0.12.2 (2026-11-20) — a failed fix attempt shows the API error in the fix log and no
//                          longer lands in «Ошибки» (the slide keeps its current image).
//   v0.13.0 (2026-11-20) — «Скачать все» saves one ZIP (slide-01.jpg …, no compression,
//                          JPEGs stay metadata-free). Where the browser supports it
//                          (Chrome/Edge) a «Save as» dialog lets you pick the folder,
//                          for the ZIP and for a single JPEG; elsewhere a normal download.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import '@fontsource/tiktok-sans/500.css';
import '@fontsource/tiktok-sans/600.css';
import '@fontsource/tiktok-sans/700.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/instrument-sans/700.css';
import '@fontsource/cormorant/700.css';
import '@fontsource/oswald/600.css';
import '@fontsource/gabarito/600.css';
import '@fontsource/montserrat/700.css';
import {
  ASPECT_RATIOS,
  DEFAULT_SETTINGS,
  EXPORT_SIZE,
  IMAGE_MODELS,
  IMAGE_SIZES,
  GPT_QUALITIES,
  TEXT_POSITIONS,
  TEXT_STYLES,
  findModel,
  altModelFor,
  sanitizeSettings,
  type SlidesSettings,
} from '@/lib/slides/config';
import { canvasToBlob, compressImage, renderSlide, type TextOptions } from '@/lib/slides/render';
import { zipSync } from 'fflate';
import type { SlidesImport } from '@/lib/carousels/toSlides';
import { placementIssues, textIssues, type CheckIssue } from '@/lib/slides/checkLocal';

const STORAGE_KEY = 'samspy.slides.settings.v1';
const MAX_FILES = 20; // per upload batch
const COMPRESS_CONCURRENCY = 3;
const GEN_CONCURRENCY = 3; // slides generated at once by «Сгенерировать все»
const GEN_RETRIES = 2; // extra attempts on rate limit / server / network errors
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_FIX_ATTEMPTS = 2; // auto-fix tries per slide

/** Lower = better: fail = 3, warn = 1 (unchecked versions rank last). */
function checkScore(c: SlideCheck | null): number {
  if (!c) return 1e6;
  return c.issues.reduce((n, i) => n + (i.severity === 'fail' ? 3 : 1), 0);
}

/** Edit prompt for the CURRENT generated image: fix only the reported photo problems. */
function fixPrompt(problems: string[]): string {
  return (
    'Edit this photo. Keep everything else exactly the same — composition, camera angle, ' +
    'framing, colors, lighting, people, buildings and objects. Fix ONLY these problems ' +
    `(reported in Russian): ${problems.map((p) => `«${p}»`).join('; ')}. ` +
    'All signs, billboards and screens must show either real, correctly spelled text or be ' +
    'naturally out of focus — no garbled or fake letters. People must have natural anatomy ' +
    '(faces, hands, fingers). Architecture must keep correct, realistic geometry. ' +
    'Photorealistic, shot on a phone, no watermark.'
  );
}

/** Natural file-name order: 2.jpg before 10.jpg. */
const byName = (a: File, b: File) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

interface SlideMeta {
  ms: number;
  costUsd: number | null;
  costKind: 'tokens' | 'avg';
  usage: { textIn: number; imageIn: number; imageOut: number };
  model: string;
}

interface SlideCheck {
  sig: string; // what was checked (photo + text + style); stale when it changes
  status: 'ok' | 'warn' | 'fail';
  issues: CheckIssue[];
  aiError: string | null; // AI check failed — only local checks were applied
}

interface SlideVersion {
  image: string;
  label: string; // «Исходная», «Попытка 1», «Попытка (Gemini)»
  model: string;
  check: SlideCheck | null;
}

interface Slide {
  id: string;
  versions: SlideVersion[]; // original generation + every auto-fix, to compare / switch
  fixLog: string[]; // what the auto-fix did
  check: SlideCheck | null;
  checking: boolean;
  source: string | null; // reference photo (downscaled JPEG data URL)
  result: string | null; // generated photo (JPEG data URL)
  text: string;
  busy: boolean;
  error: string | null;
  meta: SlideMeta | null;
}

function newSlide(): Slide {
  return {
    id: Math.random().toString(36).slice(2, 10),
    versions: [],
    fixLog: [],
    check: null,
    checking: false,
    source: null,
    result: null,
    text: '',
    busy: false,
    error: null,
    meta: null,
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Fingerprint of what a check covers: generated photo + text + text style + format. */
function checkSig(slide: Slide, s: SlidesSettings): string {
  const r = slide.result ?? '';
  return [
    r.length,
    r.slice(-48),
    slide.text,
    s.aspect,
    s.textSize,
    s.textPosition,
    s.textStyle,
    s.textOffset,
    s.textMaxWidth,
    s.textRotate,
    s.subtitleSize,
  ].join('|');
}

const CHECK_ICON: Record<SlideCheck['status'], { icon: string; cls: string }> = {
  ok: { icon: '✓', cls: 'bg-green-600' },
  warn: { icon: '!', cls: 'bg-amber-500' },
  fail: { icon: '✕', cls: 'bg-red-600' },
};

function textOptions(s: SlidesSettings, text: string): TextOptions {
  return {
    text,
    sizePct: s.textSize,
    position: s.textPosition,
    style: s.textStyle,
    offsetPct: s.textOffset,
    maxWidthPct: s.textMaxWidth,
    subtitlePct: s.subtitleSize,
    rotateDeg: s.textRotate,
  };
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type SaveTarget = { write: (blob: Blob) => Promise<void> } | null;

/**
 * Opens a «Save as» dialog where supported (Chrome / Edge: showSaveFilePicker) so the
 * user picks the folder. Must run straight from the click, before any slow work.
 * Returns a writer, `null` if the user cancelled, or a plain-download fallback.
 */
async function pickSaveTarget(filename: string, mime: string, ext: string): Promise<SaveTarget> {
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{
      createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
    }>;
  };
  if (typeof w.showSaveFilePicker !== 'function') {
    return { write: async (blob) => triggerDownload(blob, filename) };
  }
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: ext.toUpperCase(), accept: { [mime]: [`.${ext}`] } }],
    });
    return {
      write: async (blob) => {
        const out = await handle.createWritable();
        await out.write(blob);
        await out.close();
      },
    };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null; // user closed the dialog
    return { write: async (blob) => triggerDownload(blob, filename) };
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

// --- small UI helpers ----------------------------------------------------------
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

export default function SlidesView({
  visible = true,
  incoming = null,
}: {
  visible?: boolean;
  incoming?: SlidesImport | null; // texts sent from «Карусели»
}) {
  const [settings, setSettings] = useState<SlidesSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [first] = useState(newSlide);
  const [slides, setSlides] = useState<Slide[]>([first]);
  const [activeId, setActiveId] = useState(first.id);
  const [dragOver, setDragOver] = useState(false);
  const [stripDrag, setStripDrag] = useState(false);
  const [pendingImport, setPendingImport] = useState<SlidesImport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);
  const [checking, setChecking] = useState(false);

  const slidesRef = useRef(slides);
  const activeRef = useRef(activeId);
  const settingsRef = useRef(settings);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    slidesRef.current = slides;
  }, [slides]);
  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Load / persist settings.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSettings(sanitizeSettings(JSON.parse(raw)));
    } catch {
      /* ignore broken storage */
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage full / disabled */
    }
  }, [settings, loaded]);

  const set = <K extends keyof SlidesSettings>(k: K, v: SlidesSettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  // Updates a slide. Also updates slidesRef right away, so async pipelines
  // (generate → check → fix) read fresh data without waiting for a re-render.
  const patch = useCallback((id: string, p: Partial<Slide>) => {
    slidesRef.current = slidesRef.current.map((s) => (s.id === id ? { ...s, ...p } : s));
    setSlides((list) => list.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }, []);

  const logFix = useCallback(
    (id: string, msg: string) => {
      const cur = slidesRef.current.find((s) => s.id === id);
      if (cur) patch(id, { fixLog: [...cur.fixLog, msg] });
    },
    [patch]
  );

  const activeIndex = Math.max(0, slides.findIndex((s) => s.id === activeId));
  const active = slides[activeIndex] ?? slides[0];
  const model = findModel(settings.modelId) ?? IMAGE_MODELS[0];
  const exp = EXPORT_SIZE[settings.aspect];

  // --- reference photo input ---------------------------------------------------
  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 6000);
  }, []);

  /**
   * One file → it becomes the current slide's reference (replaces an existing one).
   * Several files → the first fills the current slide if it has no reference yet,
   * every other file gets a new slide at the end. Files are taken in natural name order.
   */
  const handleFiles = useCallback(
    async (list: FileList | File[] | null | undefined) => {
      const all = Array.from(list ?? []);
      if (!all.length) return;

      const images = all.filter((f) => f.type.startsWith('image/')).sort(byName);
      const skipped = all.length - images.length;
      const over = Math.max(0, images.length - MAX_FILES);
      const files = images.slice(0, MAX_FILES);
      const notes: string[] = [];
      if (skipped) notes.push(`пропущено не-картинок: ${skipped}`);
      if (over) notes.push(`больше ${MAX_FILES} за раз — лишние ${over} не добавлены`);
      if (!files.length) {
        flash(all.length === 1 ? 'Это не картинка.' : 'Среди файлов нет картинок.');
        return;
      }

      // Decide which slide each file goes to.
      const activeId = activeRef.current;
      let targets: string[];
      if (files.length === 1) {
        targets = [activeId];
      } else {
        // Several photos: fill slides that have no photo yet (strip order), then add new slides.
        const empty = slidesRef.current.filter((s) => !s.source).map((s) => s.id);
        const fill = empty.slice(0, files.length);
        const fresh = Array.from({ length: files.length - fill.length }, newSlide);
        targets = [...fill, ...fresh.map((s) => s.id)];
        if (fresh.length) setSlides((cur) => [...cur, ...fresh]);
      }

      // Downscale in parallel (a few at a time) and fill the slides.
      let failed = 0;
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const i = next++;
          try {
            const source = await compressImage(files[i]);
            patch(targets[i], { source, result: null, meta: null, error: null });
          } catch (e) {
            failed++;
            patch(targets[i], { error: (e as Error).message });
          }
        }
      };
      await Promise.all(Array.from({ length: COMPRESS_CONCURRENCY }, worker));

      if (files.length > 1) notes.unshift(`Добавлено фото: ${files.length - failed}`);
      if (failed) notes.push(`не открылись: ${failed}`);
      if (notes.length) flash(notes.join(' · '));
    },
    [patch, flash]
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

  // --- texts from «Карусели» ----------------------------------------------------
  const applyImport = useCallback(
    (imp: SlidesImport, mode: 'replace' | 'append') => {
      const fresh = imp.texts.map((text) => ({ ...newSlide(), text }));
      if (!fresh.length) {
        flash('В этой карусели нет текстов для слайдов.');
        return;
      }
      setSlides((cur) => (mode === 'replace' ? fresh : [...cur, ...fresh]));
      setActiveId(fresh[0].id);
      setPendingImport(null);
      flash(`Тексты из ${imp.title}: ${fresh.length} слайдов. Теперь добавь фото — они встанут по порядку.`);
    },
    [flash]
  );

  // A new hand-off arrives: fill an empty workspace right away, otherwise ask.
  useEffect(() => {
    if (!incoming) return;
    const isEmpty = slidesRef.current.every((s) => !s.source && !s.result && !s.text.trim());
    if (isEmpty) applyImport(incoming, 'replace');
    else setPendingImport(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.id]);

  // --- generation ----------------------------------------------------------------
  /** Generates one slide. Retries rate-limit / server / network errors. Returns true on success. */
  /**
   * Generates one slide. Default: from the reference photo with the common prompt.
   * `fix`: edits the current generated image with a fix prompt (auto-fix).
   */
  async function generate(
    id: string,
    fix?: { prompt: string; label: string; modelId?: string }
  ): Promise<boolean> {
    const slide = slidesRef.current.find((s) => s.id === id);
    const image = fix ? slide?.result : slide?.source;
    if (!slide || !image) return false;
    patch(id, { busy: true, error: null });
    let lastErr = 'Неизвестная ошибка.';
    for (let attempt = 0; attempt <= GEN_RETRIES; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt); // 2 s, then 4 s
      const r = await generateOnce(id, image, fix?.prompt ?? settingsRef.current.prompt, fix);
      if (r.ok) return true;
      lastErr = attempt > 0 ? `${r.error} (попыток: ${attempt + 1})` : r.error;
      if (!r.retry) break;
    }
    patch(id, { busy: false, error: lastErr });
    return false;
  }

  async function generateOnce(
    id: string,
    source: string,
    prompt: string,
    fix?: { label: string; modelId?: string }
  ): Promise<{ ok: true } | { ok: false; error: string; retry: boolean }> {
    const s = settingsRef.current;
    try {
      const res = await fetch('/api/slides/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: source,
          prompt,
          modelId: fix?.modelId ?? s.modelId,
          aspect: s.aspect,
          size: s.size,
          quality: s.quality,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const fallback =
          res.status === 413
            ? 'Картинка слишком большая для запроса.'
            : res.status === 504
              ? 'Генерация не уложилась по времени, попробуй ещё раз.'
              : res.status === 429
                ? 'Слишком много запросов к API (лимит).'
                : `Ошибка HTTP ${res.status}.`;
        return { ok: false, error: data?.error ?? fallback, retry: RETRYABLE.has(res.status) };
      }
      const prev = slidesRef.current.find((x) => x.id === id);
      patch(id, {
        busy: false,
        result: data.image,
        check: null,
        // a fresh generation starts a new version list; a fix adds a version
        ...(fix
          ? {
              versions: [
                ...(prev?.versions ?? []),
                { image: data.image, label: fix.label, model: data.model, check: null },
              ],
            }
          : {
              versions: [{ image: data.image, label: 'Исходная', model: data.model, check: null }],
              fixLog: [],
            }),
        meta: {
          ms: data.ms,
          costUsd: data.costUsd,
          costKind: data.costKind === 'avg' ? 'avg' : 'tokens',
          usage: data.usage,
          model: data.model,
        },
      });
      return { ok: true };
    } catch (e) {
      // fetch itself failed — network hiccup, worth a retry
      return { ok: false, error: `Сеть: ${(e as Error).message}`, retry: true };
    }
  }

  /** Runs generate() for the given slides, GEN_CONCURRENCY at a time. */
  async function generateMany(ids: string[]) {
    if (!ids.length) return;
    setBatch(true);
    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (!(await generate(id))) failed++;
        else if (settingsRef.current.autoFix) await checkAndFix(id);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(GEN_CONCURRENCY, ids.length) }, worker));
    } finally {
      setBatch(false);
    }
    let msg = failed
      ? `Готово ${ids.length - failed} из ${ids.length} · ошибок: ${failed} — см. блок «Ошибки»`
      : `Готово: ${ids.length} из ${ids.length}`;
    if (settingsRef.current.autoFix) {
      const st = slidesRef.current.filter((s) => ids.includes(s.id) && s.check).map((s) => s.check!.status);
      const fixed = slidesRef.current.filter(
        (s) => ids.includes(s.id) && s.versions.length > 1 && s.result !== s.versions[0].image
      ).length;
      msg += ` · проверка: ✓ ${st.filter((x) => x === 'ok').length} ⚠ ${st.filter((x) => x === 'warn').length} ✕ ${st.filter((x) => x === 'fail').length} · автоисправлено: ${fixed}`;
    }
    flash(msg);
  }

  const generateAll = () =>
    generateMany(slidesRef.current.filter((s) => s.source && !s.busy).map((s) => s.id));
  const retryFailed = () =>
    generateMany(slidesRef.current.filter((s) => s.source && s.error && !s.busy).map((s) => s.id));

  // --- checks ----------------------------------------------------------------------
  /** Local + AI check of one generated slide. Returns its status (null = not checked). */
  async function checkSlide(id: string): Promise<SlideCheck['status'] | null> {
    const slide = slidesRef.current.find((s) => s.id === id);
    if (!slide?.result) return null;
    const s = settingsRef.current;
    const size = EXPORT_SIZE[s.aspect];
    const opts = textOptions(s, slide.text);
    const sig = checkSig(slide, s);
    patch(id, { checking: true });

    // 1) instant local checks
    const issues: CheckIssue[] = [...textIssues(slide.text)];
    try {
      issues.push(...(await placementIssues(slide.result, size.w, size.h, opts)));
    } catch {
      /* ignore — AI check still runs */
    }

    // 2) AI check of the finished slide (downscaled to 768 px wide to save tokens)
    let aiError: string | null = null;
    try {
      const full = document.createElement('canvas');
      await renderSlide(full, slide.result, size.w, size.h, opts);
      const small = document.createElement('canvas');
      small.width = 768;
      small.height = Math.round((768 * size.h) / size.w);
      small.getContext('2d')?.drawImage(full, 0, 0, small.width, small.height);
      const image = small.toDataURL('image/jpeg', 0.85);

      const ask = async (provider: 'claude' | 'openai') => {
        let data: { issues?: CheckIssue[]; error?: string; skipped?: boolean } | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt) await sleep(2500);
          const res = await fetch('/api/slides/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image, text: slide.text, provider }),
          });
          data = await res.json().catch(() => null);
          if (res.ok) break;
          if (!RETRYABLE.has(res.status)) break;
          data = { error: data?.error ?? `HTTP ${res.status}` };
        }
        return data;
      };

      // main check — Claude
      const main = await ask('claude');
      if (main?.issues) issues.push(...main.issues);
      else aiError = main?.error ?? 'AI-проверка не ответила.';

      // second opinion — GPT, only when everything looked clean so far
      if (!aiError && issues.length === 0) {
        const second = await ask('openai');
        if (second?.issues) {
          issues.push(...second.issues.map((i) => ({ ...i, message: `GPT: ${i.message}` })));
        } else if (second && !second.skipped && second.error) {
          aiError = `вторая проверка (GPT): ${second.error}`;
        }
      }
    } catch (e) {
      aiError = `AI-проверка: ${(e as Error).message}`;
    }

    const status: SlideCheck['status'] = issues.some((i) => i.severity === 'fail')
      ? 'fail'
      : issues.length
        ? 'warn'
        : 'ok';
    const check: SlideCheck = { sig, status, issues, aiError };
    const cur = slidesRef.current.find((x) => x.id === id);
    patch(id, {
      checking: false,
      check,
      versions: (cur?.versions ?? []).map((v) => (v.image === slide.result ? { ...v, check } : v)),
    });
    return status;
  }

  const photoIssues = (id: string) =>
    (slidesRef.current.find((s) => s.id === id)?.check?.issues ?? []).filter(
      (i) => i.type === 'photo_artifact'
    );

  /**
   * Check → if the PHOTO has problems, edit the current image with a fix prompt and
   * re-check: MAX_FIX_ATTEMPTS with the main model, then one try with the other model.
   * Every attempt is kept as a version; the best-scoring version becomes current.
   * Text / layout issues are only reported.
   */
  async function checkAndFix(id: string): Promise<SlideCheck['status'] | null> {
    let st = await checkSlide(id);
    if (!photoIssues(id).length) return st;

    const main = findModel(settingsRef.current.modelId) ?? IMAGE_MODELS[0];
    const alt = altModelFor(main.id);
    const plan = [
      ...Array.from({ length: MAX_FIX_ATTEMPTS }, (_, k) => ({
        label: `Попытка ${k + 1}`,
        modelId: main.id,
        name: main.label,
      })),
      { label: `Попытка (${alt.label})`, modelId: alt.id, name: alt.label },
    ];

    for (const step of plan) {
      const photo = photoIssues(id);
      if (!photo.length) break;
      logFix(id, `${step.label}, ${step.name}: исправляю — ${photo.map((i) => i.message).join('; ')}`);
      const ok = await generate(id, {
        prompt: fixPrompt(photo.map((i) => i.message)),
        label: step.label,
        modelId: step.modelId,
      });
      if (!ok) {
        // The slide still has a usable image, so the error goes to the fix log, not to «Ошибки».
        const err = slidesRef.current.find((s) => s.id === id)?.error;
        patch(id, { error: null });
        logFix(id, `${step.label}: генерация не удалась${err ? ` — ${err}` : ''}`);
        continue;
      }
      st = await checkSlide(id);
      if (!photoIssues(id).length) {
        logFix(id, `${step.label}: исправлено ✓`);
        break;
      }
    }

    // Keep the best version as current (fewest / mildest issues; earlier wins a tie).
    const cur = slidesRef.current.find((s) => s.id === id);
    if (cur && cur.versions.length > 1) {
      const best = cur.versions.reduce((b, v) => (checkScore(v.check) < checkScore(b.check) ? v : b));
      if (best.image !== cur.result) {
        patch(id, { result: best.image, check: best.check });
        st = best.check?.status ?? st;
      }
      if (photoIssues(id).length) {
        logFix(id, `Полностью не исправилось — выбрана лучшая версия: «${best.label}». Сравни версии ниже.`);
      } else if (best.label !== 'Исходная') {
        logFix(id, `Текущая версия: «${best.label}».`);
      }
    }
    return st;
  }

  /** One slide through the whole pipeline: generate → (auto) check & fix. */
  async function runOne(id: string) {
    if ((await generate(id)) && settingsRef.current.autoFix) await checkAndFix(id);
  }

  /** Make one of the slide's versions current (its stored check comes with it). */
  function selectVersion(id: string, v: SlideVersion) {
    patch(id, { result: v.image, check: v.check });
  }

  async function checkAll() {
    const ids = slidesRef.current.filter((s) => s.result && !s.checking).map((s) => s.id);
    if (!ids.length) return;
    setChecking(true);
    const counts = { ok: 0, warn: 0, fail: 0 };
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        const st = settingsRef.current.autoFix ? await checkAndFix(id) : await checkSlide(id);
        if (st) counts[st]++;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(GEN_CONCURRENCY, ids.length) }, worker));
    } finally {
      setChecking(false);
    }
    flash(`Проверено ${ids.length}: ✓ ${counts.ok} · ⚠ ${counts.warn} · ✕ ${counts.fail}`);
  }

  // --- live preview ---------------------------------------------------------------
  const previewSrc = active?.result ?? active?.source ?? null;
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !previewSrc) return;
    let cancelled = false;
    const off = document.createElement('canvas');
    renderSlide(off, previewSrc, exp.w, exp.h, textOptions(settings, active?.text ?? ''))
      .then(() => {
        if (cancelled) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext('2d')?.drawImage(off, 0, 0);
      })
      .catch(() => {
        /* broken image — ignore in preview */
      });
    return () => {
      cancelled = true;
    };
  }, [previewSrc, active?.text, settings, exp.w, exp.h]);

  // --- download ------------------------------------------------------------------
  const [zipping, setZipping] = useState(false);

  /** Final JPEG of a slide (text drawn, metadata stripped). */
  async function slideBlob(slide: Slide): Promise<Blob> {
    const c = document.createElement('canvas');
    await renderSlide(c, slide.result!, exp.w, exp.h, textOptions(settings, slide.text));
    return canvasToBlob(c);
  }

  async function downloadSlide(slide: Slide, index: number) {
    if (!slide.result) return;
    const target = await pickSaveTarget(`slide-${pad2(index + 1)}.jpg`, 'image/jpeg', 'jpg');
    if (!target) return;
    await target.write(await slideBlob(slide));
  }

  /** All ready slides in one ZIP: slide-01.jpg, slide-02.jpg … (numbers = strip order). */
  async function downloadAll() {
    const ready = slides.map((s, i) => ({ s, i })).filter(({ s }) => s.result);
    if (!ready.length) return;
    const target = await pickSaveTarget(`slides_${stamp()}.zip`, 'application/zip', 'zip');
    if (!target) return;
    setZipping(true);
    try {
      const files: Record<string, [Uint8Array, { level: 0 }]> = {};
      for (const { s, i } of ready) {
        const buf = new Uint8Array(await (await slideBlob(s)).arrayBuffer());
        files[`slide-${pad2(i + 1)}.jpg`] = [buf, { level: 0 }]; // JPEG is already compressed
      }
      const zip = zipSync(files);
      await target.write(new Blob([zip as BlobPart], { type: 'application/zip' }));
      flash(`Архив: ${ready.length} слайдов`);
    } catch (e) {
      flash(`Не удалось собрать архив: ${(e as Error).message}`);
    } finally {
      setZipping(false);
    }
  }

  // --- slide strip ---------------------------------------------------------------
  function addSlide() {
    const s = newSlide();
    setSlides((list) => [...list, s]);
    setActiveId(s.id);
  }

  function removeSlide(id: string) {
    setSlides((list) => {
      if (list.length === 1) {
        const s = newSlide();
        setActiveId(s.id);
        return [s];
      }
      const idx = list.findIndex((s) => s.id === id);
      const next = list.filter((s) => s.id !== id);
      if (id === activeRef.current) setActiveId(next[Math.max(0, idx - 1)].id);
      return next;
    });
  }

  // --- settings export / import / reset --------------------------------------------
  function exportSettings() {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    triggerDownload(blob, 'samspy-slides-settings.json');
  }

  async function importSettings(file: File | undefined) {
    if (!file) return;
    try {
      setSettings(sanitizeSettings(JSON.parse(await file.text())));
      setNotice('Настройки импортированы.');
    } catch {
      setNotice('Не удалось прочитать файл настроек.');
    }
    setTimeout(() => setNotice(null), 3000);
  }

  function resetSettings() {
    setSettings(DEFAULT_SETTINGS);
    setNotice('Настройки сброшены.');
    setTimeout(() => setNotice(null), 3000);
  }

  const readyCount = slides.filter((s) => s.result).length;
  const sourceCount = slides.filter((s) => s.source).length;
  const anyBusy = slides.some((s) => s.busy);
  const generatedCount = slides.filter((s) => s.result).length;
  const checkRows = slides.map((s, i) => ({
    s,
    i,
    valid: !!s.check && s.check.sig === checkSig(s, settings),
  }));
  const checkedValid = checkRows.filter((r) => r.valid);
  const staleChecks = checkRows.filter((r) => r.s.check && !r.valid && r.s.result).length;
  const failedSlides = slides
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.error && !s.busy);

  return (
    <div>
      {/* hand-off from «Карусели» when the workspace already has slides */}
      {pendingImport && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent/5 px-4 py-3 text-sm">
          <span className="mr-auto">
            Тексты из карусели <b>{pendingImport.title}</b> ({pendingImport.texts.length} слайдов)
          </span>
          <button
            onClick={() => applyImport(pendingImport, 'replace')}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
          >
            Заменить
          </button>
          <button
            onClick={() => applyImport(pendingImport, 'append')}
            className="rounded-lg border border-edge bg-white px-3 py-1.5 text-xs font-medium"
          >
            Добавить в конец
          </button>
          <button
            onClick={() => setPendingImport(null)}
            className="text-xs text-muted hover:text-gray-900"
          >
            Отмена
          </button>
        </div>
      )}

      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-end gap-4 text-sm">
        {notice && <span className="mr-auto text-xs text-muted">{notice}</span>}
        <button onClick={exportSettings} className="text-muted hover:text-gray-900">
          Экспорт настроек
        </button>
        <button onClick={() => importRef.current?.click()} className="text-muted hover:text-gray-900">
          Импорт
        </button>
        <button onClick={resetSettings} className="text-muted hover:text-gray-900">
          Сбросить
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            void importSettings(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        {/* ---------------- left: result ---------------- */}
        <section className="min-w-0">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="text-base font-semibold">Слайд {pad2(activeIndex + 1)}</h2>
            <span className="text-xs text-muted">
              {exp.w}×{exp.h} · JPEG
              {!active?.result && active?.source ? ' · превью на примере' : ''}
            </span>
          </div>

          <div className="flex flex-col items-center">
            <div
              className="relative flex w-full max-w-[460px] items-center justify-center overflow-hidden rounded-xl border border-edge bg-white"
              style={{ aspectRatio: `${exp.w} / ${exp.h}` }}
            >
              {previewSrc ? (
                <>
                  <canvas ref={previewRef} className="h-full w-full object-contain" />
                  {!active?.result && (
                    <span className="absolute left-2 top-2 rounded bg-gray-900/70 px-2 py-0.5 text-[11px] text-white">
                      пример — ещё не сгенерировано
                    </span>
                  )}
                </>
              ) : (
                <div className="px-8 text-center">
                  <p className="font-medium">Здесь появится слайд.</p>
                  <p className="mt-1 text-sm text-muted">
                    Добавь пример справа и нажми «Сгенерировать».
                  </p>
                </div>
              )}
              {active?.busy && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-medium">
                  Генерация…
                </div>
              )}
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => active && void downloadSlide(active, activeIndex)}
                disabled={!active?.result}
                className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                Скачать JPEG
              </button>
              {readyCount > 1 && (
                <button
                  onClick={() => void downloadAll()}
                  disabled={zipping}
                  className="rounded-lg border border-edge bg-white px-5 py-2 text-sm font-medium disabled:opacity-40"
                >
                  {zipping ? 'Собираю архив…' : `Скачать все (${readyCount}) · ZIP`}
                </button>
              )}
            </div>
          </div>

          {/* slide strip — also a drop target for several files */}
          <div
            className={`mt-6 border-t pt-4 transition ${stripDrag ? 'border-accent bg-accent/5' : 'border-edge'}`}
            onDragOver={(e) => {
              e.preventDefault();
              setStripDrag(true);
            }}
            onDragLeave={() => setStripDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setStripDrag(false);
              void handleFiles(e.dataTransfer.files);
            }}
          >
            <div className="flex flex-wrap gap-3">
              {slides.map((s, i) => {
                const thumb = s.result ?? s.source;
                const isActive = s.id === activeId;
                return (
                  <div key={s.id} className="group relative">
                    <button
                      onClick={() => setActiveId(s.id)}
                      className={`relative block h-24 w-[72px] overflow-hidden rounded-lg border-2 bg-white ${
                        isActive ? 'border-accent' : 'border-edge'
                      }`}
                    >
                      {thumb && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumb}
                          alt=""
                          className={`h-full w-full object-cover ${s.result ? '' : 'opacity-50'}`}
                        />
                      )}
                      <span className="absolute left-1 top-1 rounded bg-gray-900/80 px-1 text-[10px] font-semibold text-white">
                        {pad2(i + 1)}
                      </span>
                      {s.busy && (
                        <span className="absolute inset-0 flex items-center justify-center bg-white/70 text-[10px]">
                          …
                        </span>
                      )}
                      {s.error && !s.busy && (
                        <span className="absolute bottom-1 right-1 h-2 w-2 rounded-full bg-red-500" />
                      )}
                      {s.checking ? (
                        <span className="absolute bottom-1 left-1 rounded bg-gray-900/70 px-1 text-[10px] text-white">
                          …
                        </span>
                      ) : s.check && s.check.sig === checkSig(s, settings) ? (
                        <span
                          className={`absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white ${CHECK_ICON[s.check.status].cls}`}
                        >
                          {CHECK_ICON[s.check.status].icon}
                        </span>
                      ) : null}
                    </button>
                    <button
                      onClick={() => removeSlide(s.id)}
                      title="Удалить слайд"
                      className="absolute -right-2 -top-2 hidden h-5 w-5 items-center justify-center rounded-full border border-edge bg-white text-xs text-muted hover:text-gray-900 group-hover:flex"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <button
                onClick={addSlide}
                title="Добавить слайд"
                className="flex h-24 w-[72px] items-center justify-center rounded-lg border-2 border-dashed border-edge text-2xl text-muted hover:text-gray-900"
              >
                +
              </button>
            </div>
            <p className="mt-3 text-xs text-muted">
              Можно перетащить сюда сразу несколько фото — каждое станет слайдом (порядок по
              имени файла, до {MAX_FILES} за раз). Картинки живут до перезагрузки страницы.
              Настройки сохраняются.
            </p>
          </div>
        </section>

        {/* ---------------- right: settings ---------------- */}
        <aside className="space-y-5 rounded-xl border border-edge bg-white p-5">
          {/* reference */}
          <div>
            <span className={labelCls}>Пример</span>
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
              {active?.source ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={active.source} alt="" className="h-20 w-16 rounded object-cover" />
              ) : null}
              <div className="text-muted">
                <p className="font-medium text-gray-900">
                  {active?.source ? 'Заменить пример' : 'Перетащи картинки сюда'}
                </p>
                <p>или вставь из буфера (Cmd+V), или нажми, чтобы выбрать</p>
                <p className="text-xs">
                  JPEG, PNG, WebP · несколько файлов → новые слайды (до {MAX_FILES})
                </p>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {/* prompt + model */}
          <div className="space-y-3 border-t border-edge pt-5">
            <Field label="Промпт">
              <textarea
                value={settings.prompt}
                onChange={(e) => set('prompt', e.target.value)}
                rows={7}
                className={`${inputCls} resize-y`}
              />
            </Field>

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
                  onChange={(e) => set('aspect', e.target.value as SlidesSettings['aspect'])}
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
                  onChange={(e) => set('size', e.target.value as SlidesSettings['size'])}
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
                  onChange={(e) => set('quality', e.target.value as SlidesSettings['quality'])}
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

          </div>

          {/* text overlay — same block as prompt/model, no divider */}
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <Field label="Размер, %">
                <input
                  type="number"
                  min={2}
                  max={20}
                  step={0.5}
                  value={settings.textSize}
                  onChange={(e) => set('textSize', Number(e.target.value))}
                  className={inputCls}
                />
              </Field>
              <Field label="Позиция">
                <select
                  value={settings.textPosition}
                  onChange={(e) =>
                    set('textPosition', e.target.value as SlidesSettings['textPosition'])
                  }
                  className={inputCls}
                >
                  {TEXT_POSITIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Стиль">
                <select
                  value={settings.textStyle}
                  onChange={(e) => set('textStyle', e.target.value as SlidesSettings['textStyle'])}
                  className={inputCls}
                >
                  {TEXT_STYLES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Field label="Сдвиг, % высоты">
                <input
                  type="number"
                  min={-50}
                  max={50}
                  step={1}
                  value={settings.textOffset}
                  onChange={(e) => set('textOffset', Number(e.target.value))}
                  className={inputCls}
                />
              </Field>
              <Field label="Макс. ширина, %">
                <input
                  type="number"
                  min={20}
                  max={100}
                  step={1}
                  value={settings.textMaxWidth}
                  onChange={(e) => set('textMaxWidth', Number(e.target.value))}
                  className={inputCls}
                />
              </Field>
              <Field label="Наклон, °">
                <input
                  type="number"
                  min={-45}
                  max={45}
                  step={1}
                  value={settings.textRotate}
                  onChange={(e) => set('textRotate', Number(e.target.value))}
                  className={inputCls}
                />
              </Field>
              <Field label="Подзаголовок, %">
                <input
                  type="number"
                  min={30}
                  max={100}
                  step={5}
                  value={settings.subtitleSize}
                  onChange={(e) => set('subtitleSize', Number(e.target.value))}
                  className={inputCls}
                />
              </Field>
            </div>
            <div>
              <span className={labelCls}>
                Тексты слайдов ({slides.length}) — Enter = новая строка, пустая строка →
                подзаголовок, пусто = без текста
              </span>
              <div className="space-y-2">
                {slides.map((s, i) => {
                  const thumb = s.result ?? s.source;
                  const isActive = s.id === activeId;
                  return (
                    <div key={s.id} className="flex items-start gap-2">
                      <button
                        onClick={() => setActiveId(s.id)}
                        title={`Слайд ${pad2(i + 1)}`}
                        className={`relative h-14 w-11 shrink-0 overflow-hidden rounded border-2 bg-gray-50 ${
                          isActive ? 'border-accent' : 'border-edge'
                        }`}
                      >
                        {thumb && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={thumb} alt="" className="h-full w-full object-cover" />
                        )}
                        <span className="absolute left-0.5 top-0.5 rounded bg-gray-900/80 px-0.5 text-[9px] font-semibold text-white">
                          {pad2(i + 1)}
                        </span>
                      </button>
                      <textarea
                        value={s.text}
                        onFocus={() => setActiveId(s.id)}
                        onChange={(e) => patch(s.id, { text: e.target.value })}
                        rows={2}
                        placeholder={`Текст слайда ${pad2(i + 1)}`}
                        className={`${inputCls} resize-y ${isActive ? 'border-accent' : ''}`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
          {/* actions: generate / check / errors */}
          <div className="space-y-3 border-t border-edge pt-5">
            <label className="flex cursor-pointer items-start gap-2 text-xs text-gray-900">
              <input
                type="checkbox"
                checked={settings.autoFix}
                onChange={(e) => set('autoFix', e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <b>Автопроверка и автоисправление</b> — после генерации каждый слайд проверяется;
                проблемы на фото (кривые надписи, искажения) исправляются автоматически: до{' '}
                {MAX_FIX_ATTEMPTS} попыток основной моделью, потом одна попытка другой (GPT ↔
                Gemini), остаётся лучшая версия. Проблемы текста — только подсказки.
              </span>
            </label>
            <button
              onClick={() => active && void runOne(active.id)}
              disabled={!active?.source || active.busy || batch}
              className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              {active?.busy ? 'Генерация…' : 'Сгенерировать'}
            </button>
            {sourceCount > 1 && (
              <button
                onClick={() => void generateAll()}
                disabled={batch || anyBusy}
                className="w-full rounded-lg border border-edge bg-white py-2 text-sm font-medium disabled:opacity-40"
              >
                {batch
                  ? `Генерирую… ${slides.filter((s) => s.busy).length} в работе`
                  : `Сгенерировать все (${sourceCount}) · по ${GEN_CONCURRENCY} сразу`}
              </button>
            )}

            {generatedCount > 0 && (
              <button
                onClick={() => void checkAll()}
                disabled={checking || batch}
                className="w-full rounded-lg border border-edge bg-white py-2 text-sm font-medium disabled:opacity-40"
              >
                {checking
                  ? `Проверяю… ${slides.filter((s) => s.checking).length} в работе`
                  : `Проверить (${generatedCount})`}
              </button>
            )}

            {/* check results */}
            {(checkedValid.length > 0 || staleChecks > 0) && (
              <div className="rounded-lg border border-edge bg-gray-50 p-3 text-xs">
                <div className="mb-2 font-semibold text-gray-900">
                  Проверка: ✓ {checkedValid.filter((r) => r.s.check?.status === 'ok').length} · ⚠{' '}
                  {checkedValid.filter((r) => r.s.check?.status === 'warn').length} · ✕{' '}
                  {checkedValid.filter((r) => r.s.check?.status === 'fail').length}
                </div>
                {staleChecks > 0 && (
                  <p className="mb-2 text-muted">
                    Изменились после проверки: {staleChecks} — нажми «Проверить» ещё раз.
                  </p>
                )}
                <ul className="space-y-2">
                  {checkedValid
                    .filter(
                      (r) =>
                        r.s.check &&
                        (r.s.check.status !== 'ok' || r.s.check.aiError || r.s.fixLog.length > 0)
                    )
                    .map(({ s, i }) => (
                      <li key={s.id}>
                        <button
                          onClick={() => setActiveId(s.id)}
                          className="font-semibold text-gray-900 hover:underline"
                        >
                          Слайд {pad2(i + 1)} {CHECK_ICON[s.check!.status].icon}
                        </button>
                        <ul className="mt-0.5 space-y-0.5">
                          {s.check!.issues.map((it, k) => (
                            <li
                              key={k}
                              className={it.severity === 'fail' ? 'text-red-700' : 'text-amber-700'}
                            >
                              • {it.message}
                            </li>
                          ))}
                          {s.check!.aiError && (
                            <li className="text-muted">• AI-проверка не прошла: {s.check!.aiError}</li>
                          )}
                          {s.fixLog.map((m, k) => (
                            <li key={`f${k}`} className="text-muted">
                              ↻ {m}
                            </li>
                          ))}
                        </ul>
                        {s.versions.length > 1 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {s.versions.map((v, k) => {
                              const isCur = v.image === s.result;
                              return (
                                <button
                                  key={k}
                                  onClick={() => selectVersion(s.id, v)}
                                  title={`${v.label} · ${v.model}`}
                                  className={`w-16 overflow-hidden rounded border-2 bg-white text-left ${
                                    isCur ? 'border-accent' : 'border-edge'
                                  }`}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={v.image} alt="" className="h-20 w-full object-cover" />
                                  <div className="px-1 py-0.5 text-[9px] leading-tight text-gray-900">
                                    {v.check ? CHECK_ICON[v.check.status].icon + ' ' : ''}
                                    {v.label}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {/* errors panel */}
            {failedSlides.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-semibold text-red-700">
                    Ошибки ({failedSlides.length})
                  </span>
                  {failedSlides.some(({ s }) => s.source) && (
                    <button
                      onClick={() => void retryFailed()}
                      disabled={batch}
                      className="rounded border border-red-300 bg-white px-2 py-0.5 text-red-700 disabled:opacity-40"
                    >
                      Повторить все с ошибкой
                    </button>
                  )}
                </div>
                <ul className="space-y-1.5">
                  {failedSlides.map(({ s, i }) => (
                    <li key={s.id} className="flex items-start gap-2">
                      <button
                        onClick={() => setActiveId(s.id)}
                        className="shrink-0 font-semibold text-red-700 hover:underline"
                      >
                        Слайд {pad2(i + 1)}
                      </button>
                      <span className="flex-1 break-words text-red-700">{s.error}</span>
                      {s.source && (
                        <button
                          onClick={() => void runOne(s.id)}
                          disabled={batch}
                          className="shrink-0 text-red-700 underline disabled:opacity-40"
                        >
                          Повторить
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-xs text-muted">
              {active?.error ? (
                <span className="text-red-600">{active.error}</span>
              ) : active?.meta ? (
                <>
                  Готово за {(active.meta.ms / 1000).toFixed(0)} с
                  {active.meta.costUsd != null && active.meta.costKind === 'avg' ? (
                    <> · ≈ ${active.meta.costUsd.toFixed(3)} (средняя цена вызова fal)</>
                  ) : active.meta.costUsd != null ? (
                    <>
                      {' '}
                      · ${active.meta.costUsd.toFixed(3)} (
                      {active.meta.usage.textIn + active.meta.usage.imageIn} вх +{' '}
                      {active.meta.usage.imageOut} изобр. токенов)
                    </>
                  ) : (
                    ' · стоимость — в биллинге fal'
                  )}
                </>
              ) : !active?.source ? (
                'Сначала добавь картинку-пример.'
              ) : null}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
