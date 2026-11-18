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
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  sanitizeSettings,
  type SlidesSettings,
} from '@/lib/slides/config';
import { canvasToBlob, compressImage, renderSlide, type TextOptions } from '@/lib/slides/render';

const STORAGE_KEY = 'samspy.slides.settings.v1';

interface SlideMeta {
  ms: number;
  costUsd: number | null;
  usage: { textIn: number; imageIn: number; imageOut: number };
  model: string;
}

interface Slide {
  id: string;
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
    source: null,
    result: null,
    text: '',
    busy: false,
    error: null,
    meta: null,
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function textOptions(s: SlidesSettings, text: string): TextOptions {
  return {
    text,
    sizePct: s.textSize,
    position: s.textPosition,
    style: s.textStyle,
    offsetPct: s.textOffset,
    maxWidthPct: s.textMaxWidth,
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

export default function SlidesView({ visible = true }: { visible?: boolean }) {
  const [settings, setSettings] = useState<SlidesSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [first] = useState(newSlide);
  const [slides, setSlides] = useState<Slide[]>([first]);
  const [activeId, setActiveId] = useState(first.id);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);

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

  const patch = useCallback((id: string, p: Partial<Slide>) => {
    setSlides((list) => list.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }, []);

  const activeIndex = Math.max(0, slides.findIndex((s) => s.id === activeId));
  const active = slides[activeIndex] ?? slides[0];
  const model = findModel(settings.modelId) ?? IMAGE_MODELS[0];
  const exp = EXPORT_SIZE[settings.aspect];

  // --- reference photo input ---------------------------------------------------
  const handleFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      const id = activeRef.current;
      if (!file.type.startsWith('image/')) {
        patch(id, { error: 'Это не картинка.' });
        return;
      }
      try {
        const source = await compressImage(file);
        patch(id, { source, result: null, meta: null, error: null });
      } catch (e) {
        patch(id, { error: (e as Error).message });
      }
    },
    [patch]
  );

  // Cmd+V anywhere on the tab — only when the clipboard holds an image.
  useEffect(() => {
    if (!visible) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith('image/')
      );
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        void handleFile(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFile, visible]);

  // --- generation ----------------------------------------------------------------
  async function generate(id: string) {
    const slide = slidesRef.current.find((s) => s.id === id);
    if (!slide?.source) return;
    const s = settingsRef.current;
    patch(id, { busy: true, error: null });
    try {
      const res = await fetch('/api/slides/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: slide.source,
          prompt: s.prompt,
          modelId: s.modelId,
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
              : `Ошибка HTTP ${res.status}.`;
        throw new Error(data?.error ?? fallback);
      }
      patch(id, {
        busy: false,
        result: data.image,
        meta: { ms: data.ms, costUsd: data.costUsd, usage: data.usage, model: data.model },
      });
    } catch (e) {
      patch(id, { busy: false, error: (e as Error).message });
    }
  }

  async function generateAll() {
    setBatch(true);
    try {
      for (const s of slidesRef.current) {
        if (s.source && !s.busy) await generate(s.id);
      }
    } finally {
      setBatch(false);
    }
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
  async function downloadSlide(slide: Slide, index: number) {
    if (!slide.result) return;
    const c = document.createElement('canvas');
    await renderSlide(c, slide.result, exp.w, exp.h, textOptions(settings, slide.text));
    triggerDownload(await canvasToBlob(c), `slide-${pad2(index + 1)}.jpg`);
  }

  async function downloadAll() {
    const ready = slides.map((s, i) => ({ s, i })).filter(({ s }) => s.result);
    for (const { s, i } of ready) {
      await downloadSlide(s, i);
      await new Promise((r) => setTimeout(r, 250)); // let the browser keep up
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

  return (
    <div>
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
                <canvas
                  ref={previewRef}
                  className={`h-full w-full object-contain ${active?.result ? '' : 'opacity-60'}`}
                />
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
                  className="rounded-lg border border-edge bg-white px-5 py-2 text-sm font-medium"
                >
                  Скачать все ({readyCount})
                </button>
              )}
            </div>
          </div>

          {/* slide strip */}
          <div className="mt-6 border-t border-edge pt-4">
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
              Картинки живут до перезагрузки страницы. Настройки сохраняются.
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
                void handleFile(e.dataTransfer.files?.[0]);
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
                  {active?.source ? 'Заменить пример' : 'Перетащи картинку сюда'}
                </p>
                <p>или вставь из буфера (Cmd+V), или нажми, чтобы выбрать</p>
                <p className="text-xs">JPEG, PNG, WebP</p>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
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

            <button
              onClick={() => active && void generate(active.id)}
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
                {batch ? 'Генерирую все…' : `Сгенерировать все (${sourceCount})`}
              </button>
            )}

            <p className="text-xs text-muted">
              {active?.error ? (
                <span className="text-red-600">{active.error}</span>
              ) : active?.meta ? (
                <>
                  Готово за {(active.meta.ms / 1000).toFixed(0)} с
                  {active.meta.costUsd != null ? (
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

          {/* text overlay */}
          <div className="space-y-3 border-t border-edge pt-5">
            <Field label="Текст слайда">
              <textarea
                value={active?.text ?? ''}
                onChange={(e) => active && patch(active.id, { text: e.target.value })}
                rows={3}
                placeholder="Enter = новая строка. Пусто = без плашек."
                className={`${inputCls} resize-y`}
              />
            </Field>

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
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
