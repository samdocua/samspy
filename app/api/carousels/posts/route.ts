// SamSpy — Carousel posts base («База постов»)
//   GET /api/carousels/posts?q=&sort=recent|likes|outlier&min_outlier=&offset=&limit=
//       -> { posts (with slides), total, noOutlier } — collected posts, each once, repeats hidden
//   POST /api/carousels/posts -> { job } counting the outlier for posts without it (or job: null)
//
// Version history:
//   v0.7.0 (2026-11-20) — initial.
//   v0.7.1 (2026-11-20) — POST: job that counts the outlier for posts collected earlier.

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { createStatsJob, getJobCard, listBasePosts, type BaseSort } from '@/lib/carousels/pipeline';

export const dynamic = 'force-dynamic';

const SORTS: BaseSort[] = ['recent', 'likes', 'outlier'];

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const sort = SORTS.includes(p.get('sort') as BaseSort) ? (p.get('sort') as BaseSort) : 'recent';
  try {
    const res = await listBasePosts(createServiceClient(), {
      q: p.get('q') ?? '',
      sort,
      minOutlier: Number(p.get('min_outlier') ?? 0) || 0,
      offset: Number(p.get('offset') ?? 0) || 0,
      limit: Number(p.get('limit') ?? 50) || 50,
    });
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST() {
  const supabase = createServiceClient();
  try {
    const job = await createStatsJob(supabase);
    return NextResponse.json({ job: job ? await getJobCard(supabase, job.id) : null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
