import { createHash } from 'node:crypto';
import type { ProjectionSnapshot } from './snapshot-store.js';

/**
 * Sleeper's own weekly projections.
 *
 * These are the incumbent we have to beat, so we snapshot them under their own
 * source name. Once several weeks accumulate, their systematic bias — the
 * "house effect" — becomes measurable and correctable rather than inherited.
 */

const V2 = 'https://api.sleeper.com';

export interface ScoringLike {
  readonly rec: number;
  readonly passYd: number;
  readonly passTd: number;
  readonly passInt: number;
  readonly rushYd: number;
  readonly rushTd: number;
  readonly recYd: number;
  readonly recTd: number;
  readonly fumbleLost: number;
}

/**
 * Stable fingerprint of a scoring system.
 *
 * A projection is only comparable to another projection under the same rules —
 * 12 points in full PPR is not 12 points in standard. Hashing the rules lets us
 * store one row per scoring system without inventing a league join.
 */
export const scoringKey = (s: ScoringLike): string =>
  createHash('sha256')
    .update(
      [s.rec, s.passYd, s.passTd, s.passInt, s.rushYd, s.rushTd, s.recYd, s.recTd, s.fumbleLost].join('|'),
    )
    .digest('hex')
    .slice(0, 12);

/** Sleeper stat keys -> our scoring fields. */
const STAT_TO_RULE: Readonly<Record<string, keyof ScoringLike>> = {
  rec: 'rec',
  pass_yd: 'passYd',
  pass_td: 'passTd',
  pass_int: 'passInt',
  rush_yd: 'rushYd',
  rush_td: 'rushTd',
  rec_yd: 'recYd',
  rec_td: 'recTd',
  fum_lost: 'fumbleLost',
};

export const scoreStats = (stats: Readonly<Record<string, number>>, scoring: ScoringLike): number => {
  let points = 0;
  for (const [statKey, value] of Object.entries(stats)) {
    const rule = STAT_TO_RULE[statKey];
    if (rule === undefined) continue;
    points += value * scoring[rule];
  }
  return points;
};

interface RawProjection {
  readonly player_id: string;
  readonly stats: Readonly<Record<string, number>> | null;
  readonly opponent?: string | null;
}

/**
 * Fetch and score one week of Sleeper projections.
 *
 * Note this scores raw stat lines ourselves rather than trusting Sleeper's
 * `pts_ppr` field, so the same projection can be re-scored under any league's
 * rules without a second fetch.
 */
export const fetchSleeperProjections = async (
  season: number,
  week: number,
  scoring: ScoringLike,
): Promise<ProjectionSnapshot[]> => {
  const res = await fetch(`${V2}/projections/nfl/${season}/${week}?season_type=regular`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Sleeper projections ${res.status} for ${season} wk ${week}`);

  const rows = (await res.json()) as RawProjection[];
  const capturedAt = new Date().toISOString();
  const key = scoringKey(scoring);

  return rows
    .filter((r) => r.stats !== null && Object.keys(r.stats).length > 0)
    .map((r) => ({
      season,
      week,
      playerId: r.player_id,
      source: 'sleeper',
      sourceVersion: '',
      points: Math.round(scoreStats(r.stats!, scoring) * 100) / 100,
      scoringKey: key,
      capturedAt,
    }))
    .filter((p) => p.points > 0);
};
