// SamSpy — MultiplyView («Размножение» tab)
//
// One reference photo → N copies with small differences (camera angle, zoom,
// moment). Each copy = one /api/slides/generate call (Gemini direct or GPT Image
// via fal) with the base prompt from «Слайды» + its own variation. No text overlay.
// Images live in memory until reload; settings persist in localStorage.
//
// Version history:
//   v0.1.0 (2026-11-20) — upload / drag / Cmd+V, count 1–20, strength min/medium,
//                         3 copies in parallel with auto-retry, «Стоп», per-copy
//                         «Ещё раз» / download / delete, «+ Ещё N», full-size view,
//                         ZIP of all copies (metadata-free JPEGs), total cost.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { zipSync } from 'fflate';
import {
  ASPECT_RATIOS,
  EXPORT_SIZE,
  GPT_QUALITIES,
  IMAGE_MODELS,
  IMAGE_SIZES,
  findModel,
} from '@/lib/slides/config';
import { canvasToBlob, compressImage, renderSlide } from '@/lib/slides/render';
import { pickSaveTarget, stamp } from '@/lib/slides/save';
import {
  MAX_COUNT,
  MIN_COUNT,
  MULTIPLY_STORAGE_KEY,
  STRENGTHS,
  buildVariations,
  copyPrompt,
  defaultsFromSlides,
  sanitizeMultiply,
  slidesPrompt,
  type MultiplySettings,
} from '@/lib/multiply/config';

const GEN_CONCURRENCY = 3;
const GEN_RETRIES = 2;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n: number) => String(n).padStart(2, '0');

interface Copy {
  id: string;
  variation: string;
  status: 'queued' | 'busy' | 'done' | 'error';
  image: string | null; // JPEG data URL
  error: string | null;
  ms: number | null;
  costUsd: number | null;
  costKind: 'tokens' | 'avg';
}

function newCopy(variation: string): Copy {
  return {
    id: Math.random().toString(36).slice(2, 10),
    variation,
    status: 'queued',
    image: null,
    error: null,
    ms: null,
    costUsd: null,
    costKind: 'tokens',
  };
}

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
    setTimeout(() => setNotice(null), 6000);
  }, []);

  // Updates a copy; keeps copiesRef in sync right away for the async workers.
  const patch = useCallback((id: string, p: Partial<Copy>) => {
    copiesRef.current = copiesRef.current.map((c) => (c.id === id ? { ...c, ...p } : c));
    setCopies(copiesRef.current);
  }, []);

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

  // --- generation -------------------------------------------------------------------
  async function generateOnce(
    id: string
  ): Promise<{ ok: true } | { ok: false; error: string; retry: boolean }> {
    const s = settingsRef.current;
    const src = sourceRef.current;
    const copy = copiesRef.current.find((c) => c.id === id);
    if (!s || !src || !copy) return { ok: false, error: 'Нет фото.', retry: false };
    try {
      const res = await fetch('/api/slides/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: src,
          prompt: copyPrompt(s.prompt, copy.variation, s.strength),
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
              ? 'Генерация не уложилась по времени.'
              : res.status === 429
                ? 'Слишком много запросов к API (лимит).'
                : `Ошибка HTTP ${res.status}.`;
        return { ok: false, error: data?.error ?? fallback, retry: RETRYABLE.has(res.status) };
      }
      patch(id, {
        status: 'done',
        image: data.image,
        error: null,
        ms: data.ms,
        costUsd: data.costUsd ?? null,
        costKind: data.costKind === 'avg' ? 'avg' : 'tokens',
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Сеть: ${(e as Error).message}`, retry: true };
    }
  }

  /** One copy with auto-retry on rate limit / server / network errors. */
  async function generateCopy(id: string): Promise<boolean> {
    patch(id, { status: 'busy', error: null });
    let lastErr = 'Неизвестная ошибка.';
    for (let attempt = 0; attempt <= GEN_RETRIES; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt);
      const r = await generateOnce(id);
      if (r.ok) return true;
      lastErr = attempt > 0 ? `${r.error} (попыток: ${attempt + 1})` : r.error;
      if (!r.retry) break;
    }
    patch(id, { status: 'error', error: lastErr });
    return false;
  }

  /** Runs the given copies GEN_CONCURRENCY at a time; «Стоп» stops taking new ones. */
  async function runQueue(ids: string[]) {
    if (!ids.length) return;
    stopRef.current = false;
    setRunning(true);
    let next = 0;
    let ok = 0;
    let failed = 0;
    const worker = async () => {
      while (next < ids.length && !stopRef.current) {
        const id = ids[next++];
        if (await generateCopy(id)) ok++;
        else failed++;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(GEN_CONCURRENCY, ids.length) }, worker));
    } finally {
      setRunning(false);
    }
    const left = ids.length - ok - failed;
    flash(
      `Готово ${ok} из ${ids.length}` +
        (failed ? ` · ошибок: ${failed}` : '') +
        (left ? ` · остановлено, не запущено: ${left}` : '')
    );
  }

  /** New batch: replaces the current copies. */
  function startNew() {
    const s = settingsRef.current;
    if (!s || !source || running) return;
    const list = buildVariations(s.count, s.strength).map(newCopy);
    replaceCopies(list);
    void runQueue(list.map((c) => c.id));
  }

  /** «+ Ещё N»: appends copies with variations not used yet. */
  function addMore() {
    const s = settingsRef.current;
    if (!s || !source || running) return;
    const used = copiesRef.current.map((c) => c.variation);
    const list = buildVariations(s.count, s.strength, used).map(newCopy);
    replaceCopies([...copiesRef.current, ...list]);
    void runQueue(list.map((c) => c.id));
  }

  function retryCopy(id: string) {
    if (running) return;
    void runQueue([id]);
  }

  function retryFailed() {
    if (running) return;
    void runQueue(copiesRef.current.filter((c) => c.status === 'error').map((c) => c.id));
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
  const costs = copies.filter((c) => c.image && c.costUsd != null);
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {copies.map((c, i) => (
                <div key={c.id} className="group relative">
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
                        {c.status === 'busy'
                          ? 'Генерация…'
                          : c.status === 'error'
                            ? <span className="text-red-600">{c.error}</span>
                            : running
                              ? 'В очереди'
                              : 'Не запущено'}
                      </div>
                    )}
                    {c.image && c.status === 'busy' && (
                      <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs font-medium">
                        Генерация…
                      </div>
                    )}
                    <span className="absolute left-1.5 top-1.5 rounded bg-gray-900/80 px-1.5 text-[11px] font-semibold text-white">
                      {pad2(i + 1)}
                    </span>
                    <button
                      onClick={() => removeCopy(c.id)}
                      disabled={c.status === 'busy'}
                      title="Удалить копию"
                      className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-full border border-edge bg-white text-xs text-muted hover:text-gray-900 group-hover:flex disabled:hidden"
                    >
                      ×
                    </button>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted" title={c.variation}>
                    {c.variation}
                  </p>
                  <div className="mt-1 flex gap-3 text-xs">
                    {c.image && (
                      <button
                        onClick={() => void downloadCopy(c, i)}
                        className="font-medium text-accent hover:underline"
                      >
                        Скачать
                      </button>
                    )}
                    {(c.status === 'done' || c.status === 'error' || (c.status === 'queued' && !running)) && (
                      <button
                        onClick={() => retryCopy(c.id)}
                        disabled={running}
                        className="text-muted hover:text-gray-900 disabled:opacity-40"
                      >
                        {c.status === 'done' ? 'Ещё раз' : 'Сгенерировать'}
                      </button>
                    )}
                    {c.ms != null && c.image && (
                      <span className="ml-auto text-muted">{(c.ms / 1000).toFixed(0)} с</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {copies.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {readyCount > 0 && (
                <button
                  onClick={() => void downloadAll()}
                  disabled={zipping}
                  className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {zipping ? 'Собираю архив…' : `Скачать все (${readyCount}) · ZIP`}
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
          </div>

          <div className="space-y-2 border-t border-edge pt-5">
            {running ? (
              <button
                onClick={() => {
                  stopRef.current = true;
                  flash('Останавливаю: текущие копии допишутся, новые не начнутся.');
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
