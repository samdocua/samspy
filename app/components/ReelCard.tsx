// SamSpy — ReelCard
//   v0.1.0 (2026-11-17) — thumbnail, outlier badge, views, author.
//   v0.1.1 (2026-11-17) — hide the author line when the handle is unknown
//                         (top-reels digest has no @username).
//   v0.2.0 (2026-11-17) — optional "hide author" button (blacklist).
//   v0.3.0 (2026-11-17) — selectable mode: click toggles selection instead of
//                         opening the reel (used to copy URLs in manage mode).
'use client';

import Image from 'next/image';
import type { ReelWithCompetitor } from '@/lib/types/db';
import { compactNumber, outlierLabel, relativeDate } from '@/lib/format';

export default function ReelCard({
  reel,
  onHide,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  reel: ReelWithCompetitor;
  /** When set, shows a "hide author" button that calls this with the reel. */
  onHide?: (reel: ReelWithCompetitor) => void;
  /** When true, clicking the card toggles selection instead of opening it. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (reel: ReelWithCompetitor) => void;
}) {
  // Known handle, or null when we don't have one (don't show "@unknown").
  const author = reel.competitor?.username ?? reel.author_username ?? null;

  const inner = (
    <>
      {/* thumbnail (9:16-ish) */}
      <div className="relative aspect-[9/14] w-full overflow-hidden bg-black">
        {onHide && !selectable && (
          <button
            type="button"
            title="Скрыть автора"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onHide(reel);
            }}
            className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white opacity-0 transition hover:bg-red-600 group-hover:opacity-100"
          >
            ✕
          </button>
        )}

        {/* selection checkbox */}
        {selectable && (
          <span
            className={`absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-bold ${
              selected
                ? 'border-accent bg-accent text-white'
                : 'border-white/80 bg-black/40 text-transparent'
            }`}
          >
            ✓
          </span>
        )}

        {reel.thumbnail_url ? (
          <Image
            src={reel.thumbnail_url}
            alt={reel.caption ?? 'reel'}
            fill
            sizes="(max-width:768px) 50vw, 240px"
            className="object-cover transition group-hover:scale-[1.03]"
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted">
            no preview
          </div>
        )}

        {/* outlier badge */}
        {reel.outlier_ratio != null && (
          <span
            className={`absolute left-2 top-2 rounded-md px-2 py-0.5 text-xs font-bold ${
              reel.is_outlier ? 'bg-accent text-white' : 'bg-black/70 text-muted'
            }`}
          >
            {outlierLabel(reel.outlier_ratio)}
          </span>
        )}

        {/* metric, bottom gradient. Show views when present, else likes
            (IG can return views=0 on early syncs). */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2">
          <span className="text-sm font-semibold text-white">
            {reel.views > 0
              ? `${compactNumber(reel.views)} views`
              : `${compactNumber(reel.likes)} likes`}
          </span>
        </div>
      </div>

      {/* footer */}
      <div className="flex items-center justify-between px-2.5 py-2">
        <span className="truncate text-xs text-muted">
          {author ? `@${author}` : ''}
        </span>
        <span className="shrink-0 text-xs text-muted">
          {relativeDate(reel.published_at)}
        </span>
      </div>
    </>
  );

  const cardClass = `group block overflow-hidden rounded-xl border bg-white shadow-sm transition hover:shadow-md ${
    selected ? 'border-accent ring-2 ring-accent' : 'border-edge hover:border-accent/60'
  }`;

  // Selectable mode: the card is a button that toggles selection.
  if (selectable) {
    return (
      <button
        type="button"
        onClick={() => onToggleSelect?.(reel)}
        className={`${cardClass} text-left`}
      >
        {inner}
      </button>
    );
  }

  // Normal mode: the card opens the reel on its platform.
  return (
    <a href={reel.url} target="_blank" rel="noopener noreferrer" className={cardClass}>
      {inner}
    </a>
  );
}
