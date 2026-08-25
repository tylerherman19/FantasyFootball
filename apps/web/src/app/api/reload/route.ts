import { clearSleeperCache } from '@ffe/adapters';
import { NextResponse } from 'next/server';
import { invalidateAll } from '@/lib/cache';

export const dynamic = 'force-dynamic';

/**
 * Drop serve-time league caches without crossing the protected refresh boundary.
 * The next page render reads Sleeper again; database writes and metered provider
 * refreshes remain restricted to the authenticated cron endpoint.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  if (origin === null || origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: 'same-origin request required' }, { status: 403 });
  }

  invalidateAll();
  clearSleeperCache();

  return NextResponse.json({ message: 'Sleeper and league data reloaded.' });
}
