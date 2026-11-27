// SamSpy — «Потрачено ≈ $X» of a dossier / plan (API calls recorded in ai_usage)
//
// One line with the total and the split by service; a click opens the split by step and model.
// Calls are recorded since 27.11.2026 — older work is not in it.
//
// Version history:
//   v0.1.0 (2026-11-27) — initial.
'use client';

import { useEffect, useState } from 'react';
import type { UsageTotals } from '@/lib/usage';

const NAMES: Record<string, string> = { anthropic: 'Claude', openai: 'GPT', scrapecreators: 'ScrapeCreators' };
const STEPS: Record<string, string> = {
  apify: 'сбор постов',
  comments: 'комментарии',
  texts: 'расшифровка / OCR топа',
  tag: 'разметка',
  breakdown: 'разборы топа',
  synth: 'выводы досье',
  slides: 'распознавание слайдов',
  copy: 'копии',
  playbook: 'плейбук',
  write: 'новые посты',
  review: 'проверка GPT',
  proofread: 'корректура копий',
  regenerate: '«Другой пост»',
};
const usd = (x: number) => (x < 0.01 && x > 0 ? '<$0.01' : `$${x.toFixed(2)}`);

export default function UsageLine({ refId, refreshKey }: { refId: string; refreshKey?: unknown }) {
  const [u, setU] = useState<UsageTotals | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let off = false;
    fetch(`/api/usage?ref=${refId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !off && d && setU(d))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [refId, refreshKey]);
  if (!u || !u.total) return null;
  return (
    <div className="text-xs text-muted">
      <button onClick={() => setOpen(!open)} className="hover:text-gray-900" title="Учитывается с 27.11.2026">
        Потрачено ≈ <span className="font-medium text-gray-900">{usd(u.total)}</span>
        {' · '}
        {Object.entries(u.byProvider)
          .sort((a, b) => b[1] - a[1])
          .map(([p, c]) => `${NAMES[p] ?? p} ${usd(c)}`)
          .join(' · ')}{' '}
        {open ? '▴' : '▾'}
      </button>
      {open && (
        <table className="mt-2 w-full max-w-lg text-left">
          <tbody>
            {u.byStep.map((r) => (
              <tr key={`${r.step}|${r.provider}|${r.model}`} className="border-t border-edge">
                <td className="py-1 pr-3">{STEPS[r.step] ?? (r.step || '—')}</td>
                <td className="py-1 pr-3 font-mono">{r.model}</td>
                <td className="py-1 pr-3 text-right">{r.calls}×</td>
                <td className="py-1 text-right font-medium text-gray-900">{usd(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
