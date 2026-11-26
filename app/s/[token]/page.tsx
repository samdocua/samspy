// SamSpy — /s/:token — slides sent «На телефон» (public page, no password: the token is the key)
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.

import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase';
import { getShare } from '@/lib/shares';
import ShareClient from './ShareClient';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Слайды',
  robots: { index: false, follow: false },
};

export default async function SharePage({ params }: { params: { token: string } }) {
  const share = await getShare(createServiceClient(), params.token);
  if (!share) {
    return (
      <main className="mx-auto max-w-md px-5 py-16 text-center">
        <p className="text-lg font-semibold">Ссылка не найдена</p>
        <p className="mt-2 text-sm text-muted">Слайды удалены или прошло 7 дней.</p>
      </main>
    );
  }
  return <ShareClient share={share} />;
}
