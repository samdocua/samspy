// SamSpy — SlidesView («Слайды» tab)
//
// Text overlay only (photos are generated in «Размножение»): photo per slide (random pick
// from a folder of copies, or drag / Cmd+V) → text overlay on canvas → check of the overlay
// → download JPEG / ZIP. Images live in memory until reload; settings persist in
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
//   v0.11.0 (2026-11-19) — full auto pipeline (setting «Автопроверка и автоисправление»).
//   v0.12.0 (2026-11-19) — slide versions (original + every fix) with their checks.
//   v0.12.1 (2026-11-19) — second opinion: after a clean Claude check the slide also goes
//                          to GPT (provider 'openai'); its findings are prefixed «GPT:».
//   v0.12.2 (2026-11-20) — a failed fix attempt shows the API error in the fix log.
//   v0.13.0 (2026-11-20) — «Скачать все» saves one ZIP (slide-01.jpg …, no compression,
//                          JPEGs stay metadata-free); «Save as» dialog where supported.
//   v1.0.0 (2026-11-20) — TEXT ONLY: prompt, models, generation, auto-fix and versions
//                          removed (generation lives in «Размножение»). Photos: pick a
//                          folder of copies («<original>_<n>.jpg»); each slide gets a random
//                          photo from a DIFFERENT original (group), groups not used in
//                          earlier carousels first; warning when there are fewer groups than
//                          slides; «Перемешать все», «Другое фото» per slide; folder
//                          remembered in Chrome/Edge. Groups count as used once slides are
//                          downloaded («Сбросить память»). Check = text overlay only.
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
  TEXT_POSITIONS,
  TEXT_STYLES,
  sanitizeSettings,
  type SlidesSettings,
} from '@/lib/slides/config';
import { canvasToBlob, compressImage, renderSlide, type TextOptions } from '@/lib/slides/render';
import { pickSaveTarget, stamp, triggerDownload } from '@/lib/slides/save';
import { zipSync } from 'fflate';
import type { SlidesImport } from '@/lib/carousels/toSlides';
import { placementIssues, textIssues, type CheckIssue } from '@/lib/slides/checkLocal';
import {
  canPickDirectory,
  clearUsed,
  markUsed,
  pickDirectory,
  pickPhotos,
  poolFromFileList,
  reopenSaved,
  savedFolderName,
  usedGroups,
  type Pool,
  type PoolFile,
} from '@/lib/slides/pool';

const STORAGE_KEY = 'samspy.slides.settings.v1';
const MAX_FILES = 20; // per manual upload batch
const COMPRESS_CONCURRENCY = 3;
const CHECK_CONCURRENCY = 3;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Natural file-name order: 2.jpg before 10.jpg. */
const byName = (a: File, b: File) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

interface SlideCheck {
  sig: string; // what was checked (photo + text + style); stale when it changes
  status: 'ok' | 'warn' | 'fail';
  issues: CheckIssue[];
  aiError: string | null; // AI check failed — only local checks were applied
}

interface Slide {
  id: string;
  source: string | null; // photo (downscaled JPEG data URL)
  file: { name: string; group: string } | null; // when the photo came from the folder
  text: string;
  check: SlideCheck | null;
  checking: boolean;
  loading: boolean; // photo is being opened
  error: string | null;
}

function newSlide(): Slide {
  return {
    id: Math.random().toString(36).slice(2, 10),
    source: null,
    file: null,
    text: '',
    check: null,
    checking: false,
    loading: false,
    error: null,
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Fingerprint of what a check covers: photo + text + text style + format. */
function checkSig(slide: Slide, s: SlidesSettings): string {
  const r = slide.source ?? '';
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

// --- small UI helpers ----------------------------------------------------------
const labelCls = 'mb-1 block text-xs font-medium text-muted';
const inputCls =
  'w-full rounded-lg border border-edge bg-white px-3 py-2 text-sm outline-none focus:border-accent';
const btnCls = 'rounded-lg border border-edge bg-white px-3 py-1.5 text-xs font-medium disabled:opacity-40';

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
  const [checking, setChecking] = useState(false);
  const [pool, setPool] = useState<Pool | null>(null);
  const [savedFolder, setSavedFolder] = useState<string | null>(null);
  const [usedCount, setUsedCount] = useState(0);
  const [picking, setPicking] = useState(false);

  const slidesRef = useRef(slides);
  const activeRef = useRef(activeId);
  const settingsRef = useRef(settings);
  const poolRef = useRef<Pool | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
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

  // <input webkitdirectory> (fallback for browsers without showDirectoryPicker)
  useEffect(() => {
    folderRef.current?.setAttribute('webkitdirectory', '');
    folderRef.current?.setAttribute('directory', '');
  });

  // Load / persist settings.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSettings(sanitizeSettings(JSON.parse(raw)));
    } catch {
      /* ignore broken storage */
    }
    setLoaded(true);
    void savedFolderName().then(setSavedFolder);
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

  // Updates a slide. Also updates slidesRef right away, so async work reads fresh data.
  const patch = useCallback((id: string, p: Partial<Slide>) => {
    slidesRef.current = slidesRef.current.map((s) => (s.id === id ? { ...s, ...p } : s));
    setSlides((list) => list.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }, []);

  const replaceSlides = (list: Slide[]) => {
    slidesRef.current = list;
    setSlides(list);
  };

  const activeIndex = Math.max(0, slides.findIndex((s) => s.id === activeId));
  const active = slides[activeIndex] ?? slides[0];
  const exp = EXPORT_SIZE[settings.aspect];

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 9000);
  }, []);

  // --- manual photos (drag / Cmd+V / picker) -------------------------------------------
  /**
   * One file → it becomes the current slide's photo. Several files → slides without a
   * photo first (strip order), extras → new slides. Natural name order.
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

      let targets: string[];
      if (files.length === 1) {
        targets = [activeRef.current];
      } else {
        const empty = slidesRef.current.filter((s) => !s.source).map((s) => s.id);
        const fill = empty.slice(0, files.length);
        const fresh = Array.from({ length: files.length - fill.length }, newSlide);
        targets = [...fill, ...fresh.map((s) => s.id)];
        if (fresh.length) replaceSlides([...slidesRef.current, ...fresh]);
      }

      let failed = 0;
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const i = next++;
          try {
            const source = await compressImage(files[i]);
            patch(targets[i], { source, file: null, check: null, error: null });
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

  // --- photos from a folder ------------------------------------------------------------------
  const refreshUsed = (p: Pool | null) =>
    setUsedCount(p ? Array.from(usedGroups(p.key)).filter((g) => p.groups.has(g)).length : 0);

  /** Opens one picked file into a slide. */
  async function loadInto(id: string, f: PoolFile): Promise<boolean> {
    patch(id, { loading: true, error: null });
    try {
      const source = await compressImage(await f.get());
      patch(id, { source, file: { name: f.name, group: f.group }, check: null, loading: false });
      return true;
    } catch (e) {
      patch(id, { loading: false, error: `${f.name}: ${(e as Error).message}` });
      return false;
    }
  }

  /**
   * Fills the given slides with random photos from different groups. Groups already on the
   * OTHER slides are skipped; groups used in earlier carousels go last.
   */
  async function fillSlides(ids: string[]) {
    const p = poolRef.current;
    if (!p || !ids.length) return;
    const others = new Set(
      slidesRef.current.filter((s) => !ids.includes(s.id) && s.file).map((s) => s.file!.group)
    );
    const used = usedGroups(p.key);
    const r = pickPhotos(p, ids.length, others, used);
    setPicking(true);
    try {
      let next = 0;
      let failed = 0;
      const worker = async () => {
        while (next < r.picks.length) {
          const i = next++;
          if (!(await loadInto(ids[i], r.picks[i]))) failed++;
        }
      };
      await Promise.all(Array.from({ length: COMPRESS_CONCURRENCY }, worker));
      // slides that got no photo (not enough groups) — cleared, so no group repeats
      for (const id of ids.slice(r.picks.length)) {
        patch(id, { source: null, file: null, check: null });
      }
      const notes = [`Фото подобраны: ${r.picks.length - failed} из ${ids.length}`];
      if (r.short) {
        notes.push(
          `⚠ не хватает разных фото: в папке ${p.groups.size} групп, нужно ещё ${r.short} — добавь копии других оригиналов`
        );
      }
      if (r.fromUsed) notes.push(`из уже использованных групп: ${r.fromUsed}`);
      if (failed) notes.push(`не открылись: ${failed}`);
      flash(notes.join(' · '));
    } finally {
      setPicking(false);
    }
  }

  const fillEmpty = () => fillSlides(slidesRef.current.filter((s) => !s.source).map((s) => s.id));
  const shuffleAll = () => fillSlides(slidesRef.current.map((s) => s.id));
  const otherPhoto = (id: string) => fillSlides([id]);

  /** A new folder is ready: remember it, fill slides that have no photo yet. */
  async function usePool(p: Pool | null, emptyMsg: string) {
    if (!p) {
      flash(emptyMsg);
      return;
    }
    poolRef.current = p;
    setPool(p);
    refreshUsed(p);
    setSavedFolder(canPickDirectory() ? p.key : null);
    flash(`Папка «${p.key}»: ${p.files.length} фото · ${p.groups.size} оригиналов (групп)`);
    if (slidesRef.current.some((s) => !s.source)) await fillEmpty();
  }

  async function chooseFolder() {
    if (canPickDirectory()) {
      setPicking(true);
      const p = await pickDirectory().finally(() => setPicking(false));
      if (p !== null || poolRef.current === null) void usePool(p, 'В папке нет картинок (JPEG, PNG, WebP).');
    } else {
      folderRef.current?.click();
    }
  }

  async function reopenFolder() {
    setPicking(true);
    try {
      const p = await reopenSaved();
      await usePool(p, 'Не удалось открыть папку — выбери её заново.');
    } catch {
      flash('Не удалось открыть папку — выбери её заново.');
    } finally {
      setPicking(false);
    }
  }

  function resetUsed() {
    if (!pool) return;
    clearUsed(pool.key);
    refreshUsed(pool);
    flash('Память использованных фото для этой папки сброшена.');
  }

  /** Groups of the slides that are downloaded count as used for the next carousels. */
  function rememberUsed(list: Slide[]) {
    const p = poolRef.current;
    if (!p) return;
    markUsed(
      p.key,
      list.filter((s) => s.file).map((s) => s.file!.group)
    );
    refreshUsed(p);
  }

  // --- texts from «Карусели» ----------------------------------------------------
  const applyImport = useCallback(
    (imp: SlidesImport, mode: 'replace' | 'append') => {
      const fresh = imp.texts.map((text) => ({ ...newSlide(), text }));
      if (!fresh.length) {
        flash('В этой карусели нет текстов для слайдов.');
        return;
      }
      replaceSlides(mode === 'replace' ? fresh : [...slidesRef.current, ...fresh]);
      setActiveId(fresh[0].id);
      setPendingImport(null);
      if (poolRef.current) {
        void fillSlides(fresh.map((s) => s.id));
      } else {
        flash(`Тексты из ${imp.title}: ${fresh.length} слайдов. Выбери папку с фото — они подберутся сами.`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flash]
  );

  // A new hand-off arrives: fill an empty workspace right away, otherwise ask.
  useEffect(() => {
    if (!incoming) return;
    const isEmpty = slidesRef.current.every((s) => !s.source && !s.text.trim());
    if (isEmpty) applyImport(incoming, 'replace');
    else setPendingImport(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.id]);

  // --- checks ----------------------------------------------------------------------
  /** Local + AI check of the text overlay of one slide. Returns its status. */
  async function checkSlide(id: string): Promise<SlideCheck['status'] | null> {
    const slide = slidesRef.current.find((s) => s.id === id);
    if (!slide?.source) return null;
    const s = settingsRef.current;
    const size = EXPORT_SIZE[s.aspect];
    const opts = textOptions(s, slide.text);
    const sig = checkSig(slide, s);
    patch(id, { checking: true });

    // 1) instant local checks
    const issues: CheckIssue[] = [...textIssues(slide.text)];
    try {
      issues.push(...(await placementIssues(slide.source, size.w, size.h, opts)));
    } catch {
      /* ignore — AI check still runs */
    }

    // 2) AI check of the finished slide (downscaled to 768 px wide to save tokens)
    let aiError: string | null = null;
    try {
      const full = document.createElement('canvas');
      await renderSlide(full, slide.source, size.w, size.h, opts);
      const small = document.createElement('canvas');
      small.width = 768;
      small.height = Math.round((768 * size.h) / size.w);
      small.getContext('2d')?.drawImage(full, 0, 0, small.width, small.height);
      const image = small.toDataURL('image/jpeg', 0.85);

      const ask = async (provider: 'claude' | 'openai') => {
        let data: { issues?: CheckIssue[]; error?: string; skipped?: boolean } | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await sleep(2500 * attempt);
          const res = await fetch('/api/slides/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image, text: slide.text, provider }),
          });
          data = await res.json().catch(() => null);
          if (res.ok) break;
          data = { error: data?.error ?? `HTTP ${res.status}` };
          if (!RETRYABLE.has(res.status)) break;
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
    patch(id, { checking: false, check: { sig, status, issues, aiError } });
    return status;
  }

  async function checkMany(ids: string[]) {
    if (!ids.length) return;
    setChecking(true);
    const counts = { ok: 0, warn: 0, fail: 0 };
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const st = await checkSlide(ids[next++]);
        if (st) counts[st]++;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, ids.length) }, worker));
    } finally {
      setChecking(false);
    }
    flash(`Проверено ${ids.length}: ✓ ${counts.ok} · ⚠ ${counts.warn} · ✕ ${counts.fail}`);
  }

  const checkAll = () =>
    checkMany(slidesRef.current.filter((s) => s.source && !s.checking).map((s) => s.id));

  // --- live preview ---------------------------------------------------------------
  const previewSrc = active?.source ?? null;
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
    await renderSlide(c, slide.source!, exp.w, exp.h, textOptions(settings, slide.text));
    return canvasToBlob(c);
  }

  async function downloadSlide(slide: Slide, index: number) {
    if (!slide.source) return;
    const target = await pickSaveTarget(`slide-${pad2(index + 1)}.jpg`, 'image/jpeg', 'jpg');
    if (!target) return;
    await target.write(await slideBlob(slide));
    rememberUsed([slide]);
  }

  /** All slides with a photo in one ZIP: slide-01.jpg, slide-02.jpg … (strip order). */
  async function downloadAll() {
    const ready = slides.map((s, i) => ({ s, i })).filter(({ s }) => s.source);
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
      rememberUsed(ready.map(({ s }) => s));
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
    replaceSlides([...slidesRef.current, s]);
    setActiveId(s.id);
  }

  function removeSlide(id: string) {
    const list = slidesRef.current;
    if (list.length === 1) {
      const s = newSlide();
      setActiveId(s.id);
      replaceSlides([s]);
      return;
    }
    const idx = list.findIndex((s) => s.id === id);
    const next = list.filter((s) => s.id !== id);
    if (id === activeRef.current) setActiveId(next[Math.max(0, idx - 1)].id);
    replaceSlides(next);
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
      flash('Настройки импортированы.');
    } catch {
      flash('Не удалось прочитать файл настроек.');
    }
  }

  function resetSettings() {
    // keep prompt / model (used by «Размножение» as its defaults), reset the rest
    setSettings((s) => ({ ...DEFAULT_SETTINGS, prompt: s.prompt, modelId: s.modelId, size: s.size, quality: s.quality }));
    flash('Настройки текста сброшены.');
  }

  const readyCount = slides.filter((s) => s.source).length;
  const checkRows = slides.map((s, i) => ({
    s,
    i,
    valid: !!s.check && s.check.sig === checkSig(s, settings),
  }));
  const checkedValid = checkRows.filter((r) => r.valid);
  const staleChecks = checkRows.filter((r) => r.s.check && !r.valid && r.s.source).length;
  const errorSlides = slides.map((s, i) => ({ s, i })).filter(({ s }) => s.error);
  const groupsOnSlides = new Set(slides.filter((s) => s.file).map((s) => s.file!.group));

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
          <button onClick={() => setPendingImport(null)} className="text-xs text-muted hover:text-gray-900">
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
        {/* ---------------- left: preview + strip ---------------- */}
        <section className="min-w-0">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="text-base font-semibold">Слайд {pad2(activeIndex + 1)}</h2>
            <span className="truncate text-xs text-muted">
              {exp.w}×{exp.h} · JPEG{active?.file ? ` · ${active.file.name}` : ''}
            </span>
          </div>

          <div className="flex flex-col items-center">
            <div
              className="relative flex w-full max-w-[460px] items-center justify-center overflow-hidden rounded-xl border border-edge bg-white"
              style={{ aspectRatio: `${exp.w} / ${exp.h}` }}
            >
              {previewSrc ? (
                <canvas ref={previewRef} className="h-full w-full object-contain" />
              ) : (
                <div className="px-8 text-center">
                  <p className="font-medium">Здесь появится слайд.</p>
                  <p className="mt-1 text-sm text-muted">
                    Выбери папку с фото справа — они подберутся сами, или перетащи фото.
                  </p>
                </div>
              )}
              {active?.loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-medium">
                  Открываю фото…
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                onClick={() => active && void downloadSlide(active, activeIndex)}
                disabled={!active?.source}
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
              {pool && active && (
                <button
                  onClick={() => void otherPhoto(active.id)}
                  disabled={picking}
                  className="rounded-lg border border-edge bg-white px-5 py-2 text-sm font-medium disabled:opacity-40"
                >
                  ↻ Другое фото
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
                const isActive = s.id === activeId;
                return (
                  <div key={s.id} className="group relative">
                    <button
                      onClick={() => setActiveId(s.id)}
                      title={s.file?.name}
                      className={`relative block h-24 w-[72px] overflow-hidden rounded-lg border-2 bg-white ${
                        isActive ? 'border-accent' : 'border-edge'
                      }`}
                    >
                      {s.source && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.source} alt="" className="h-full w-full object-cover" />
                      )}
                      <span className="absolute left-1 top-1 rounded bg-gray-900/80 px-1 text-[10px] font-semibold text-white">
                        {pad2(i + 1)}
                      </span>
                      {s.loading && (
                        <span className="absolute inset-0 flex items-center justify-center bg-white/70 text-[10px]">
                          …
                        </span>
                      )}
                      {s.error && <span className="absolute bottom-1 right-1 h-2 w-2 rounded-full bg-red-500" />}
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
                    {pool && (
                      <button
                        onClick={() => void otherPhoto(s.id)}
                        disabled={picking}
                        title="Другое фото"
                        className="absolute -bottom-2 -right-2 hidden h-5 w-5 items-center justify-center rounded-full border border-edge bg-white text-[11px] text-muted hover:text-gray-900 group-hover:flex"
                      >
                        ↻
                      </button>
                    )}
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
              Можно перетащить сюда свои фото — каждое станет слайдом (до {MAX_FILES} за раз).
              Картинки живут до перезагрузки страницы. Настройки сохраняются.
            </p>
          </div>
        </section>

        {/* ---------------- right: settings ---------------- */}
        <aside className="space-y-5 rounded-xl border border-edge bg-white p-5">
          {/* photos from a folder */}
          <div>
            <span className={labelCls}>Фото из папки (копии из «Размножения»)</span>
            {pool ? (
              <div className="rounded-lg border border-edge p-3 text-xs">
                <p className="text-sm font-medium">📁 {pool.key}</p>
                <p className="mt-0.5 text-muted">
                  {pool.files.length} фото · {pool.groups.size} оригиналов · на слайдах {groupsOnSlides.size} ·
                  уже использовано {usedCount}
                </p>
                {slides.length > pool.groups.size && (
                  <p className="mt-1 text-amber-600">
                    ⚠ Слайдов ({slides.length}) больше, чем разных оригиналов ({pool.groups.size}) — на части
                    слайдов фото не будет.
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={() => void shuffleAll()} disabled={picking} className={btnCls}>
                    ↻ Перемешать все
                  </button>
                  {slides.some((s) => !s.source) && (
                    <button onClick={() => void fillEmpty()} disabled={picking} className={btnCls}>
                      Заполнить пустые
                    </button>
                  )}
                  <button onClick={() => void chooseFolder()} disabled={picking} className={btnCls}>
                    Другая папка
                  </button>
                  {usedCount > 0 && (
                    <button onClick={resetUsed} disabled={picking} className={`${btnCls} text-muted`}>
                      Сбросить память ({usedCount})
                    </button>
                  )}
                </div>
                <p className="mt-2 text-muted">
                  На каждом слайде — фото от разного оригинала (1_1, 3_4, 17_2…). Сначала берутся
                  оригиналы, которые ещё не попадали в скачанные карусели.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border-2 border-dashed border-edge p-3 text-sm">
                <p className="font-medium">Выбери папку с копиями</p>
                <p className="text-xs text-muted">
                  Файлы вида «имя_1.jpg, имя_2.jpg…». Фото подберутся на все слайды случайно, каждое от
                  разного оригинала.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => void chooseFolder()}
                    disabled={picking}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  >
                    Выбрать папку
                  </button>
                  {savedFolder && (
                    <button onClick={() => void reopenFolder()} disabled={picking} className={btnCls}>
                      Открыть «{savedFolder}»
                    </button>
                  )}
                </div>
              </div>
            )}
            <input
              ref={folderRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void usePool(poolFromFileList(e.target.files), 'В папке нет картинок (JPEG, PNG, WebP).');
                e.target.value = '';
              }}
            />
          </div>

          {/* manual photo for the current slide */}
          <div>
            <span className={labelCls}>Своё фото на слайд {pad2(activeIndex + 1)}</span>
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
                <img src={active.source} alt="" className="h-16 w-12 rounded object-cover" />
              ) : null}
              <div className="text-xs text-muted">
                <p className="text-sm font-medium text-gray-900">
                  {active?.source ? 'Заменить фото' : 'Перетащи фото сюда'}
                </p>
                <p>или Cmd+V, или нажми, чтобы выбрать · несколько → новые слайды</p>
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

          {/* text overlay settings */}
          <div className="space-y-3 border-t border-edge pt-5">
            <div className="grid grid-cols-3 gap-2">
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
                  onChange={(e) => set('textPosition', e.target.value as SlidesSettings['textPosition'])}
                  className={inputCls}
                >
                  {TEXT_POSITIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
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

            <div className="grid grid-cols-2 gap-2">
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
                Тексты слайдов ({slides.length}) — Enter = новая строка, пустая строка → подзаголовок,
                пусто = без текста
              </span>
              <div className="space-y-2">
                {slides.map((s, i) => {
                  const isActive = s.id === activeId;
                  return (
                    <div key={s.id} className="flex items-start gap-2">
                      <button
                        onClick={() => setActiveId(s.id)}
                        title={s.file ? `Слайд ${pad2(i + 1)} · ${s.file.name}` : `Слайд ${pad2(i + 1)}`}
                        className={`relative h-14 w-11 shrink-0 overflow-hidden rounded border-2 bg-gray-50 ${
                          isActive ? 'border-accent' : 'border-edge'
                        }`}
                      >
                        {s.source && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={s.source} alt="" className="h-full w-full object-cover" />
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

          {/* check */}
          <div className="space-y-3 border-t border-edge pt-5">
            <button
              onClick={() => void checkAll()}
              disabled={checking || readyCount === 0}
              className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              {checking
                ? `Проверяю… ${slides.filter((s) => s.checking).length} в работе`
                : `Проверить текст (${readyCount})`}
            </button>
            <p className="text-xs text-muted">
              Проверяется только наложение текста: не обрезан ли, читается ли на фоне, не закрывает ли
              лицо или главный объект, нет ли опечаток. Claude, затем второе мнение GPT.
            </p>

            {(checkedValid.length > 0 || staleChecks > 0) && (
              <div className="rounded-lg border border-edge bg-gray-50 p-3 text-xs">
                <div className="mb-2 font-semibold text-gray-900">
                  Проверка: ✓ {checkedValid.filter((r) => r.s.check?.status === 'ok').length} · ⚠{' '}
                  {checkedValid.filter((r) => r.s.check?.status === 'warn').length} · ✕{' '}
                  {checkedValid.filter((r) => r.s.check?.status === 'fail').length}
                </div>
                {staleChecks > 0 && (
                  <p className="mb-2 text-muted">
                    Изменились после проверки: {staleChecks} — нажми «Проверить текст» ещё раз.
                  </p>
                )}
                <ul className="space-y-2">
                  {checkedValid
                    .filter((r) => r.s.check && (r.s.check.status !== 'ok' || r.s.check.aiError))
                    .map(({ s, i }) => (
                      <li key={s.id}>
                        <button onClick={() => setActiveId(s.id)} className="font-semibold text-gray-900 hover:underline">
                          Слайд {pad2(i + 1)} {CHECK_ICON[s.check!.status].icon}
                        </button>
                        <ul className="mt-0.5 space-y-0.5">
                          {s.check!.issues.map((it, k) => (
                            <li key={k} className={it.severity === 'fail' ? 'text-red-700' : 'text-amber-700'}>
                              • {it.message}
                            </li>
                          ))}
                          {s.check!.aiError && (
                            <li className="text-muted">• AI-проверка не прошла: {s.check!.aiError}</li>
                          )}
                        </ul>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {errorSlides.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs">
                <div className="mb-1 font-semibold text-red-700">Ошибки ({errorSlides.length})</div>
                <ul className="space-y-1">
                  {errorSlides.map(({ s, i }) => (
                    <li key={s.id} className="text-red-700">
                      <button onClick={() => setActiveId(s.id)} className="font-semibold hover:underline">
                        Слайд {pad2(i + 1)}
                      </button>
                      : {s.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
