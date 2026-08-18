import { SleeperClient } from '@ffe/adapters';

/**
 * Live injury status, cached briefly.
 *
 * Projections are rebuilt weekly; injuries change daily. A player ruled out on
 * Saturday must not be in Sunday's optimal lineup, so this is read live rather
 * than baked into the artifact — but the underlying file is three megabytes, so
 * it is fetched at most every fifteen minutes and shared across requests.
 */

export interface Availability {
  readonly injuryStatus: string | null;
  readonly team: string | null;
}

const CACHE_MS = 15 * 60 * 1000;
let cache: { at: number; data: Record<string, Availability> } | null = null;
let inFlight: Promise<Record<string, Availability>> | null = null;

export const loadAvailability = async (): Promise<Record<string, Availability>> => {
  if (cache !== null && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (inFlight !== null) return inFlight;

  inFlight = (async () => {
    try {
      const data = await new SleeperClient().getAvailability();
      cache = { at: Date.now(), data };
      return data;
    } catch {
      // Stale availability beats none: a page that renders last hour's injury
      // report is far more useful than one that fails.
      return cache?.data ?? {};
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
};
