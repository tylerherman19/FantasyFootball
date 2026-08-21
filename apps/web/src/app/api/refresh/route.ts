import { NextResponse } from 'next/server';
import { REFRESHABLE, runRefresh, type SourceId } from '@/lib/refresh-runner';

/**
 * Force refresh. A real one — not a browser reload.
 *
 * `POST /api/refresh` refreshes everything refreshable.
 * `POST /api/refresh?source=values` refreshes one source.
 *
 * **Authentication.** This writes to the database and spends third-party API
 * quota, so it is not open. Vercel Cron sends a bearer token matching
 * `CRON_SECRET`; a human sends the same token. With no `CRON_SECRET` configured
 * the route refuses rather than defaulting open — an unauthenticated endpoint
 * that burns a metered API key is a bill, and possibly a denial of service
 * against your own data.
 */

export const dynamic = 'force-dynamic';
// Refreshing several providers means several sequential network round trips.
export const maxDuration = 60;

const authorized = (request: Request): boolean => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get('authorization');
  return header === `Bearer ${secret}`;
};

const parseSources = (url: URL): SourceId[] | null => {
  const requested = url.searchParams.getAll('source').flatMap((v) => v.split(','));
  if (requested.length === 0) return [...REFRESHABLE];

  const unknown = requested.filter((s) => !REFRESHABLE.includes(s as SourceId));
  if (unknown.length > 0) return null;

  return requested as SourceId[];
};

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json(
      {
        error: process.env.CRON_SECRET
          ? 'unauthorized'
          : 'CRON_SECRET is not configured, so refresh is disabled',
      },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const sources = parseSources(url);
  if (sources === null) {
    return NextResponse.json(
      { error: 'unknown source', refreshable: REFRESHABLE },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  // Vercel Cron issues a GET-shaped scheduled invocation; anything else that
  // carries the token is a person or a script pressing the button.
  const trigger = request.headers.get('user-agent')?.includes('vercel-cron') ? 'cron' : 'manual';

  const reports = await runRefresh(sources, trigger);
  const failed = reports.filter((r) => r.status === 'failed');

  return NextResponse.json(
    {
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      trigger,
      reports,
    },
    // 207: some providers succeeded and some did not, and the caller needs to
    // be able to tell without parsing the body.
    { status: failed.length === 0 ? 200 : failed.length === reports.length ? 502 : 207 },
  );
}

/** Vercel Cron invokes scheduled paths with GET. */
export async function GET(request: Request): Promise<NextResponse> {
  return POST(request);
}
