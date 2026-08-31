import { scoreStats, type ScoringLike } from './sleeper-projections.js';

/**
 * What actually happened, and who called it.
 *
 * `projection_snapshots` has carried an `actual_points` column and a
 * `projection_snapshots_scoring_queue` index since migration 0001, and nothing
 * has ever written to either. Every projection this product has made was
 * recorded, correctly, before kickoff — and not one of them was ever marked
 * right or wrong. The moat was dug and never filled.
 *
 * That is the gap behind the deck's sharpest line: the model is proven to beat
 * its own predecessor and has never once been measured against the free
 * consensus a manager could use instead. "Better than our baseline" and "better
 * than the market" are different claims, and only the first was earned.
 *
 * Actuals are scored from raw stat lines with the same function that scores the
 * projections, under the same scoring key, so a residual is a modelling error
 * and never an accounting one.
 */

const V2 = 'https://api.sleeper.com';

interface RawStatLine {
  readonly player_id: string;
  readonly stats: Readonly<Record<string, number>> | null;
}

/**
 * One week of realised fantasy points, keyed by Sleeper id.
 *
 * Players who did not appear are absent rather than zero. "Did not play" and
 * "played and scored nothing" are different events and only the second is a
 * forecast the projection model should be charged for — a healthy scratch is an
 * availability miss, which the availability model owns and this one must not
 * quietly absorb on its behalf.
 */
export const scoreActuals = async (
  season: number,
  week: number,
  scoring: ScoringLike,
): Promise<Map<string, number>> => {
  const res = await fetch(`${V2}/stats/nfl/${season}/${week}?season_type=regular`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Sleeper stats ${res.status} for ${season} wk ${week}`);

  return actualsFrom((await res.json()) as RawStatLine[], scoring);
};

/** The pure half, so the scoring rule is testable without the network. */
export const actualsFrom = (
  rows: readonly RawStatLine[],
  scoring: ScoringLike,
): Map<string, number> => {
  const out = new Map<string, number>();

  for (const row of rows) {
    const stats = row.stats;
    if (stats === null || Object.keys(stats).length === 0) continue;
    // `gp` is games played, and it is the only field that distinguishes a
    // scoreless appearance from an absence.
    if ((stats.gp ?? 0) < 1) continue;
    out.set(row.player_id, Math.round(scoreStats(stats, scoring) * 100) / 100);
  }

  return out;
};

export interface ProjectionRow {
  readonly playerId: string;
  readonly source: string;
  readonly sourceVersion: string;
  readonly points: number;
}

export interface Accuracy {
  readonly source: string;
  readonly sourceVersion: string;
  readonly n: number;
  /** Mean absolute error in fantasy points. The headline. */
  readonly mae: number;
  readonly rmse: number;
  /** Mean signed error. Positive means the source projects too high. */
  readonly bias: number;
  /** Share of players where this source was closer than the named baseline. */
  readonly winRate?: number;
}

/**
 * Players every source covered.
 *
 * Comparing sources on their own coverage is the classic way to lose a
 * benchmark while believing you won it. A source that only projects starters
 * looks accurate because starters are predictable; one that projects the whole
 * league looks worse for being more useful. So the comparison runs on the
 * intersection, and the intersection is computed rather than assumed.
 */
export const commonPlayers = (
  rows: readonly ProjectionRow[],
  actuals: ReadonlyMap<string, number>,
): Set<string> => {
  const bySource = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.source} ${row.sourceVersion}`;
    const set = bySource.get(key) ?? new Set<string>();
    set.add(row.playerId);
    bySource.set(key, set);
  }

  const sets = [...bySource.values()];
  if (sets.length === 0) return new Set();

  const common = new Set<string>();
  for (const playerId of sets[0]!) {
    if (!actuals.has(playerId)) continue;
    if (sets.every((set) => set.has(playerId))) common.add(playerId);
  }
  return common;
};

/**
 * Error for every source, on the same players.
 *
 * `baseline` names the source each other one is scored against head to head.
 * MAE says who is better on average; the win rate says how often, which is the
 * question a manager setting a lineup is actually asking — a source can carry a
 * better mean error and still be the wrong one to trust on any given player.
 */
export const accuracyOf = (
  rows: readonly ProjectionRow[],
  actuals: ReadonlyMap<string, number>,
  { restrictTo, baseline }: { restrictTo?: ReadonlySet<string>; baseline?: string } = {},
): Accuracy[] => {
  const groups = new Map<
    string,
    { source: string; sourceVersion: string; errors: Map<string, number> }
  >();

  for (const row of rows) {
    if (restrictTo !== undefined && !restrictTo.has(row.playerId)) continue;
    const actual = actuals.get(row.playerId);
    if (actual === undefined) continue;

    const key = `${row.source} ${row.sourceVersion}`;
    const group =
      groups.get(key) ?? { source: row.source, sourceVersion: row.sourceVersion, errors: new Map() };
    group.errors.set(row.playerId, row.points - actual);
    groups.set(key, group);
  }

  const baselineErrors =
    baseline === undefined
      ? undefined
      : [...groups.values()].find((group) => group.source === baseline)?.errors;

  return [...groups.values()]
    .map(({ source, sourceVersion, errors }): Accuracy => {
      const values = [...errors.values()];
      const n = values.length;
      if (n === 0) return { source, sourceVersion, n: 0, mae: 0, rmse: 0, bias: 0 };

      const mae = values.reduce((total, e) => total + Math.abs(e), 0) / n;
      const rmse = Math.sqrt(values.reduce((total, e) => total + e * e, 0) / n);
      const bias = values.reduce((total, e) => total + e, 0) / n;

      if (baselineErrors === undefined || source === baseline) {
        return { source, sourceVersion, n, mae, rmse, bias };
      }

      let wins = 0;
      let compared = 0;
      for (const [playerId, error] of errors) {
        const against = baselineErrors.get(playerId);
        if (against === undefined) continue;
        compared += 1;
        if (Math.abs(error) < Math.abs(against)) wins += 1;
      }

      return {
        source,
        sourceVersion,
        n,
        mae,
        rmse,
        bias,
        ...(compared === 0 ? {} : { winRate: wins / compared }),
      };
    })
    .sort((a, b) => a.mae - b.mae);
};

/**
 * Is the gap between two sources real, or is it this week's luck?
 *
 * Paired, because both sources projected the same players in the same week and
 * an unpaired test throws that away — the shared difficulty of the week is the
 * largest term in the variance and it cancels exactly.
 *
 * Returns the t statistic on the paired difference in absolute error. Around
 * two is the conventional threshold, and the honest reading of anything below
 * it is that a single week does not settle this. The whole reason to record
 * every week is that a season of them does.
 */
export const pairedT = (
  rows: readonly ProjectionRow[],
  actuals: ReadonlyMap<string, number>,
  sourceA: string,
  sourceB: string,
  restrictTo?: ReadonlySet<string>,
): { t: number; n: number; meanDifference: number } => {
  const errorsFor = (source: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (const row of rows) {
      if (row.source !== source) continue;
      if (restrictTo !== undefined && !restrictTo.has(row.playerId)) continue;
      const actual = actuals.get(row.playerId);
      if (actual === undefined) continue;
      out.set(row.playerId, Math.abs(row.points - actual));
    }
    return out;
  };

  const a = errorsFor(sourceA);
  const b = errorsFor(sourceB);

  const differences: number[] = [];
  for (const [playerId, errorA] of a) {
    const errorB = b.get(playerId);
    if (errorB !== undefined) differences.push(errorA - errorB);
  }

  const n = differences.length;
  if (n < 2) return { t: 0, n, meanDifference: 0 };

  const mean = differences.reduce((total, d) => total + d, 0) / n;
  const variance = differences.reduce((total, d) => total + (d - mean) ** 2, 0) / (n - 1);
  const standardError = Math.sqrt(variance / n);

  /*
   * Zero spread with a non-zero mean is the most decisive result there is, not
   * the least.
   *
   * The first version returned t = 0 for it, on the reasoning that dividing by
   * zero is undefined — which reported "indistinguishable" for two sources that
   * differ by the same amount on every single player. Real data never lands
   * exactly there, so this would have sat unnoticed; a synthetic test found it
   * immediately, which is the argument for testing the statistics rather than
   * only the plumbing.
   */
  if (standardError === 0) {
    return { t: mean === 0 ? 0 : mean > 0 ? Infinity : -Infinity, n, meanDifference: mean };
  }

  return { t: mean / standardError, n, meanDifference: mean };
};
