import { NextResponse } from 'next/server';
import { loadLatestArtifact } from '@/lib/projections';
import { readFreshness } from '@/lib/refresh-runner';
import { defaultSeason } from '@/lib/session';

/**
 * How fresh is everything?
 *
 * Unauthenticated on purpose: it reveals timestamps and row counts, not data,
 * and the whole point is that freshness is visible everywhere without
 * ceremony. `no-store`, because a cached freshness report is a contradiction.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const artifact = await loadLatestArtifact(defaultSeason());
  const sources = await readFreshness(artifact?.generatedAt ?? null);

  const worst = sources.some((s) => s.health === 'failing' || s.health === 'never')
    ? 'failing'
    : sources.some((s) => s.health === 'stale')
      ? 'stale'
      : 'healthy';

  return NextResponse.json(
    {
      checkedAt: new Date().toISOString(),
      overall: sources.length === 0 ? 'unknown' : worst,
      model: artifact === null ? null : { version: artifact.modelVersion, generatedAt: artifact.generatedAt },
      sources,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
