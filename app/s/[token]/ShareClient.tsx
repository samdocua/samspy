// SamSpy — phone page of shared slides (client)
//
// Every slide is a full-quality <img>: a long press on iPhone → «Сохранить в Фото». «Сохранить
// все в Фото» opens the iOS share sheet with every slide («Сохранить N изображений»); the files
// are fetched when the page opens, so the tap itself starts the share (iOS wants it right in the
// tap). Where sharing files is not supported, the button downloads them one by one. «Удалить»
// removes the slides and the link.
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.
'use client';

import { useEffect, useState } from 'react';
import type { SharePublic } from '@/lib/shares';

export default function ShareClient({ share }: { share: SharePublic }) {
  const [files, setFiles] = useState<File[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let off = false;
    Promise.all(
      share.images.map(async (im) => {
        const res = await fetch(im.url, { cache: 'force-cache' });
        if (!res.ok) throw new Error(String(res.status));
        return new File([await res.blob()], im.name, { type: 'image/jpeg' });
      })
    )
      .then((f) => !off && setFiles(f))
      .catch(() => !off && setLoadErr(true));
    return () => {
      off = true;
    };
  }, [share.images]);

  async function saveAll() {
    if (!files) return;
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files }) && nav.share) {
      try {
        await nav.share({ files });
        setNote('Готово. Если слайды не появились в «Фото», выбери в меню «Сохранить изображения».');
      } catch {
        /* closed the sheet */
      }
      return;
    }
    // no file sharing (desktop browsers): download one by one
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      await new Promise((r) => setTimeout(r, 400));
      URL.revokeObjectURL(a.href);
    }
  }

  async function remove() {
    if (!confirm('Удалить эти слайды и ссылку? Скачанные в «Фото» останутся.')) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/s/${share.token}`, { method: 'DELETE' });
      if (res.ok) setDeleted(true);
      else setNote('Не удалось удалить, попробуй ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  if (deleted) {
    return (
      <main className="mx-auto max-w-md px-5 py-16 text-center">
        <p className="text-lg font-semibold">Удалено</p>
        <p className="mt-2 text-sm text-muted">Слайды и ссылка удалены.</p>
      </main>
    );
  }

  const left = Math.max(0, Math.ceil((new Date(share.expires_at).getTime() - Date.now()) / 86_400_000));

  return (
    <main className="mx-auto max-w-md px-4 pb-16 pt-6">
      <h1 className="text-lg font-semibold">{share.title || 'Слайды'}</h1>
      <p className="mt-1 text-xs text-muted">
        {share.images.length} шт. · удалятся сами через {left} дн. · зажми картинку пальцем → «Сохранить в Фото»
      </p>

      <div className="sticky top-0 z-10 -mx-4 mt-4 flex gap-2 bg-[#f7f7f8]/95 px-4 py-3 backdrop-blur">
        <button
          onClick={() => void saveAll()}
          disabled={!files}
          className="h-12 flex-1 rounded-xl bg-accent text-base font-semibold text-white disabled:opacity-50"
        >
          {files ? `Сохранить все (${files.length}) в Фото` : loadErr ? 'Не загрузилось — обнови' : 'Загружаю…'}
        </button>
        <button
          onClick={() => void remove()}
          disabled={busy}
          className="h-12 rounded-xl border border-edge bg-white px-4 text-sm font-medium text-red-600 disabled:opacity-50"
        >
          Удалить
        </button>
      </div>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}

      <div className="mt-3 space-y-4">
        {share.images.map((im, i) => (
          <figure key={im.url}>
            <figcaption className="mb-1 font-mono text-xs text-muted">{String(i + 1).padStart(2, '0')}</figcaption>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={im.url} alt={`Слайд ${i + 1}`} className="w-full rounded-xl border border-edge" />
          </figure>
        ))}
      </div>
    </main>
  );
}
