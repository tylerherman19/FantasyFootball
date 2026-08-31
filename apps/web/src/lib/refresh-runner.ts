import { refreshStoreFromEnv, withRefreshTracking } from '@ffe/ingest';
import type { RefreshCounts, RefreshTrigger, SourceFreshness } from '@ffe/ingest';
import { clearSleeperCache } from '@ffe/adapters';
import { invalidateAll } from './cache';

/**
 * What "refresh" actually does, per source.
 *
 * Two kinds of source live here and the difference is worth stating, because it
 * is the honest limit of what a serverless button can do.
 *
 * **Serve-time sources** — Sleeper league state and the caches built on it —
 * are fetched live and can genuinely be refreshed on demand.
 *
 * **Derived quantities** — asset values, above all — are computed from the
 * artifacts on each render. They were a third kind until recently, fetched from
 * a market feed on a daily cadence; they are now a function of the projections,
 * so refreshing them means refreshing those, and a button offering otherwise
 * would be theatre.
 *
 * **Model artifacts** — projections, the identity crosswalk, the nflverse lake
 * — are produced by the Python pipeline, which by design never runs in the
 * serving path. Pressing a button here cannot rebuild them; it can only report
 * how old they are. Saying so plainly is better than a button that appears to
 * work and quietly does nothing, which is roughly what the weekly GitHub Action
 * had been doing.
 */

export type SourceId = 'sleeper' | 'values' | 'projections' | 'crosswalk' | 'nflverse';

export const REFRESHABLE: readonly SourceId[] = ['sleeper'];

export interface RefreshReport {
  readonly source: string;
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly durationMs: number;
  readonly processed?: number;
  readonly added?: number;
  readonly updated?: number;
  readonly error?: string;
  readonly note?: string;
}

/**
 * Sleeper is read live on every page behind a TTL memo, so "refresh" means
 * dropping that memo rather than fetching anything here. The next request
 * repopulates it from the API.
 */
const refreshSleeper = async (): Promise<RefreshCounts> => {
  invalidateAll();
  clearSleeperCache();
  return { processed: 0 };
};

const RUNNERS: Partial<Record<SourceId, () => Promise<RefreshCounts>>> = {
  sleeper: refreshSleeper,
};

const OFFLINE_NOTE =
  'Built offline by the Python pipeline, which never runs in the serving path. ' +
  'Rebuild with model/export_projections.py; this page can only report its age.';

const DERIVED_NOTE =
  'Computed from the projection artifact on every render, per league. There is ' +
  'nothing to fetch: it is as fresh as the projections it is derived from.';

export const runRefresh = async (
  sources: readonly SourceId[],
  trigger: RefreshTrigger,
): Promise<RefreshReport[]> => {
  const store = refreshStoreFromEnv(process.env);

  return Promise.all(
    sources.map(async (source): Promise<RefreshReport> => {
      const runner = RUNNERS[source];
      if (runner === undefined) {
        return {
          source,
          status: 'skipped',
          durationMs: 0,
          note: source === 'values' ? DERIVED_NOTE : OFFLINE_NOTE,
        };
      }

      const startedAt = Date.now();
      try {
        const counts = await withRefreshTracking(store, source, trigger, async () => runner());
        return {
          source,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          processed: counts.processed,
          added: counts.added,
          updated: counts.updated,
        };
      } catch (cause) {
        return {
          source,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }),
  );
};

/**
 * Freshness for the whole product, with the artifact's own age folded in.
 *
 * The projection artifact carries `generatedAt`, which is the only truthful
 * source for how old the model output is — the database row would otherwise
 * claim whatever the last refresh *attempt* recorded.
 */
export const readFreshness = async (
  artifactGeneratedAt: string | null,
): Promise<readonly SourceFreshness[]> => {
  const rows = await refreshStoreFromEnv(process.env).readFreshness();

  if (artifactGeneratedAt === null) return rows;

  const ageMinutes = Math.round((Date.now() - Date.parse(artifactGeneratedAt)) / 60_000);

  // Values are derived from the artifact, so they are exactly as old as it is.
  // Reporting them separately would let the panel show a fresh market beside
  // stale projections, which has not been possible since the feed was removed.
  return rows.map((row) =>
    row.source === 'projections' || row.source === 'values'
      ? {
          ...row,
          dataTimestamp: artifactGeneratedAt,
          ageMinutes,
          health: ageMinutes > 60 * 24 * 7 ? 'stale' : 'healthy',
        }
      : row,
  );
};
