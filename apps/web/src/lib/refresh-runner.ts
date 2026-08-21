import { fetchAllValueConfigurations, refreshStoreFromEnv, withRefreshTracking } from '@ffe/ingest';
import type { RefreshCounts, RefreshTrigger, SourceFreshness } from '@ffe/ingest';
import { PostgrestSnapshotStore } from '@ffe/ingest';
import { invalidateAll } from './cache';

/**
 * What "refresh" actually does, per source.
 *
 * Two kinds of source live here and the difference is worth stating, because it
 * is the honest limit of what a serverless button can do.
 *
 * **Serve-time sources** — market values, Sleeper league state, and the caches
 * built on them — are fetched live and can genuinely be refreshed on demand.
 *
 * **Model artifacts** — projections, the identity crosswalk, the nflverse lake
 * — are produced by the Python pipeline, which by design never runs in the
 * serving path. Pressing a button here cannot rebuild them; it can only report
 * how old they are. Saying so plainly is better than a button that appears to
 * work and quietly does nothing, which is roughly what the weekly GitHub Action
 * had been doing.
 */

export type SourceId = 'sleeper' | 'values' | 'projections' | 'crosswalk' | 'nflverse';

export const REFRESHABLE: readonly SourceId[] = ['sleeper', 'values'];

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
 * Market values from FantasyCalc, written to the snapshot table.
 *
 * The daily series only exists because we record it — nobody publishes
 * yesterday's values — so a failed run is a permanent hole, not a delay.
 */
const refreshValues = async (): Promise<RefreshCounts> => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  const rows = await fetchAllValueConfigurations();
  if (rows.length === 0) throw new Error('FantasyCalc returned no values');

  let written = 0;
  if (url && key) {
    written = await new PostgrestSnapshotStore(url, key).writeValues(rows);
  }

  return { processed: rows.length, added: written };
};

/**
 * Sleeper is read live on every page behind a TTL memo, so "refresh" means
 * dropping that memo rather than fetching anything here. The next request
 * repopulates it from the API.
 */
const refreshSleeper = async (): Promise<RefreshCounts> => {
  invalidateAll();
  return { processed: 0 };
};

const RUNNERS: Partial<Record<SourceId, () => Promise<RefreshCounts>>> = {
  values: refreshValues,
  sleeper: refreshSleeper,
};

const OFFLINE_NOTE =
  'Built offline by the Python pipeline, which never runs in the serving path. ' +
  'Rebuild with model/export_projections.py; this page can only report its age.';

export const runRefresh = async (
  sources: readonly SourceId[],
  trigger: RefreshTrigger,
): Promise<RefreshReport[]> => {
  const store = refreshStoreFromEnv(process.env);

  return Promise.all(
    sources.map(async (source): Promise<RefreshReport> => {
      const runner = RUNNERS[source];
      if (runner === undefined) {
        return { source, status: 'skipped', durationMs: 0, note: OFFLINE_NOTE };
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

  return rows.map((row) =>
    row.source === 'projections'
      ? {
          ...row,
          dataTimestamp: artifactGeneratedAt,
          ageMinutes,
          health: ageMinutes > 60 * 24 * 7 ? 'stale' : 'healthy',
        }
      : row,
  );
};
