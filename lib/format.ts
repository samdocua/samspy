// SamSpy — display formatters (v0.1.0, 2026-11-17)

/** 1234 -> "1.2K", 1_200_000 -> "1.2M". */
export function compactNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** "12.5x" for an outlier ratio. */
export function outlierLabel(ratio: number | null | undefined): string {
  if (ratio == null) return '—';
  return `${ratio.toFixed(ratio < 10 ? 1 : 0)}x`;
}

/** ISO date -> "3d ago" / "Sep 23". */
export function relativeDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
