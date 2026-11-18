// SamSpy — GET /api/carousels/jobs/:id/csv
// Downloads the job result as CSV, one post per row (same layout as the local posts.csv).
//
// Version history:
//   v0.4.0 (2026-11-18) — CSV export.

import { createServiceClient } from '@/lib/supabase';
import { getJobPosts } from '@/lib/carousels/pipeline';
import { buildTable, toCsv } from '@/lib/carousels/table';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createServiceClient();
  const posts = await getJobPosts(supabase, params.id);
  const csv = toCsv(buildTable(posts));
  const name = `carousels-${new Date().toISOString().slice(0, 10)}-${params.id.slice(0, 8)}.csv`;
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}
