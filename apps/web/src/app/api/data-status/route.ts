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

  /*
   * Severity, not a max over labels.
   *
   * The first version rolled any `never` up to `failing`, so one optional
   * source that had simply not run yet made the entire system report as broken.
   * "Failing" should mean something is repeatedly erroring; a source that has
   * not run is incomplete, and one that is past its cadence is stale. Three
   * different words because they warrant three different reactions.
   */
  const failing = sources.filter((s) => s.health === 'failing');
  const never = sources.filter((s) => s.health === 'never');
  const stale = sources.filter((s) => s.health === 'stale');

  const worst =
    failing.length > 0
      ? 'failing'
      : never.length > 0
        ? 'incomplete'
        : stale.length > 0
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
