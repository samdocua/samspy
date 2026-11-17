// SamSpy — FiltersBar (v0.1.0, 2026-11-17)
// Period, min-outlier, min-views, sort controls for the catalog grid.
'use client';

export interface Filters {
  period: number | null;       // days, or null = all time
  minOutlier: number;          // outlier ratio threshold
  minViews: number;
  sort: 'outlier' | 'views' | 'recent';
}

export default function FiltersBar({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {/* period */}
      <select
        value={filters.period ?? 'all'}
        onChange={(e) =>
          set({ period: e.target.value === 'all' ? null : Number(e.target.value) })
        }
        className="rounded-lg border border-edge bg-white text-gray-900 px-3 py-1.5 outline-none focus:border-accent"
      >
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="all">All time</option>
      </select>

      {/* min outlier */}
      <label className="flex items-center gap-2">
        <span className="text-muted">Min outlier</span>
        <input
          type="range"
          min={0}
          max={20}
          step={1}
          value={filters.minOutlier}
          onChange={(e) => set({ minOutlier: Number(e.target.value) })}
          className="accent-accent"
        />
        <span className="w-8 font-semibold">{filters.minOutlier}x</span>
      </label>

      {/* min views */}
      <select
        value={filters.minViews}
        onChange={(e) => set({ minViews: Number(e.target.value) })}
        className="rounded-lg border border-edge bg-white text-gray-900 px-3 py-1.5 outline-none focus:border-accent"
      >
        <option value={0}>Any views</option>
        <option value={10000}>10K+</option>
        <option value={100000}>100K+</option>
        <option value={1000000}>1M+</option>
      </select>

      {/* sort */}
      <div className="ml-auto flex items-center gap-2">
        <span className="text-muted">Sort</span>
        <select
          value={filters.sort}
          onChange={(e) => set({ sort: e.target.value as Filters['sort'] })}
          className="rounded-lg border border-edge bg-white text-gray-900 px-3 py-1.5 outline-none focus:border-accent"
        >
          <option value="outlier">Outlier</option>
          <option value="views">Views</option>
          <option value="recent">Newest</option>
        </select>
      </div>
    </div>
  );
}
