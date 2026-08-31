import type { ProjectionSnapshot } from './snapshot-store.js';
import { scoringKey, type ScoringLike } from './sleeper-projections.js';

/**
 * Our own projections, captured the same way we capture everyone else's.
 *
 * The audit's sharpest finding was not that the model is weak. It is that
 * "better than the market" was never tested. The backtest proves v1 beats v0 —
 * the model beating its own predecessor — and the weekly snapshot job has been
 * faithfully recording Sleeper's consensus since before Week 1. What was never
 * recorded, in the same table, under the same scoring key, before the same
 * kickoff, was us.
 *
 * So the comparison the product's central claim rests on could not be computed.
 * Not because it was hard, but because half the data was missing.
 *
 * This is that half. It is deliberately the dullest code in the repository: it
 * reads the artifact the model already exported and reshapes it into the row
 * the accuracy table already had a column for. There is no modelling here, and
 * there must not be — a benchmark that transforms the thing it measures is not
 * a benchmark.
 */

export interface ArtifactLike {
  readonly modelVersion: string;
  readonly season: number;
  readonly week: number;
  readonly generatedAt: string;
  readonly players: Readonly<
    Record<
      string,
      {
        readonly playerId: string;
        readonly stats?: Readonly<Record<string, number>>;
        readonly sd?: number;
        readonly p25?: number;
        readonly p50?: number;
        readonly p75?: number;
        readonly active?: boolean;
        readonly byeWeek?: number | null;
      }
    >
  >;
}

/**
 * nflverse stat names to the scoring fields.
 *
 * The two feeds do not agree on a single key. Sleeper says `rec_yd`; the
 * artifact, which is built from nflverse, says `receiving_yards`. Scoring the
 * artifact with the Sleeper map returns *zero for every receiving stat* and
 * therefore near-zero points for the entire league — a benchmark that would
 * have reported the model losing to the consensus by fifteen points a player
 * and been believed, because the number is exactly what a broken model looks
 * like.
 *
 * The test that caught it is the one asserting both scorers agree on the same
 * stat line, which is worth keeping for exactly that reason.
 */
const NFLVERSE_TO_RULE: Readonly<Record<string, keyof ScoringLike>> = {
  receptions: 'rec',
  passing_yards: 'passYd',
  passing_tds: 'passTd',
  passing_interceptions: 'passInt',
  rushing_yards: 'rushYd',
  rushing_tds: 'rushTd',
  receiving_yards: 'recYd',
  receiving_tds: 'recTd',
};

/** Score an artifact stat line under one league's rules. */
export const scoreArtifactStats = (
  stats: Readonly<Record<string, number>>,
  scoring: ScoringLike,
): number => {
  let points = 0;
  for (const [statKey, value] of Object.entries(stats)) {
    const rule = NFLVERSE_TO_RULE[statKey];
    if (rule === undefined) continue;
    points += value * scoring[rule];
  }
  return points;
};

/**
 * Reshape one exported artifact into pre-kickoff snapshot rows.
 *
 * Scored under the same scoring key as the Sleeper capture, through the stat
 * translation above, so any difference between the two sources' rows is a
 * difference between the projections and nothing else — not between two feeds
 * that spell `receiving_yards` differently.
 *
 * Byes are dropped rather than recorded as zero. A player who cannot play is
 * not a forecast anybody got right, and leaving him in would hand whichever
 * source lists more inactive players a free block of perfect predictions.
 */
export const modelSnapshots = (
  artifact: ArtifactLike,
  scoring: ScoringLike,
  capturedAt: string = new Date().toISOString(),
): ProjectionSnapshot[] => {
  const key = scoringKey(scoring);

  /*
   * Fail loudly if the artifact stopped speaking a language we understand.
   *
   * The translation above silently ignores keys it does not know, which is the
   * right behaviour for a stat we do not score and a catastrophe for one we
   * thought we did. If nflverse renames `receiving_yards`, every receiver
   * scores near zero, the capture looks like a normal week of rows, and the
   * benchmark reports the model losing to the consensus by fifteen points a
   * player. That number is indistinguishable from a genuinely broken model,
   * which is exactly why it would be believed.
   *
   * A week with no rows is a visible hole in the series. A week of wrong ones
   * is a false finding, and false findings are how a team spends a month
   * fixing a model that was never broken.
   */
  const present = new Set<string>();
  for (const player of Object.values(artifact.players)) {
    for (const stat of Object.keys(player.stats ?? {})) present.add(stat);
  }

  // Yardage is the check because every football projection has some. A ratio
  // over all keys would be fragile — the artifact carries kicking and IDP stats
  // this scorer deliberately ignores, and their count moves between versions.
  const yardage = ['passing_yards', 'rushing_yards', 'receiving_yards'];
  if (present.size > 0 && !yardage.some((stat) => present.has(stat))) {
    throw new Error(
      `artifact ${artifact.modelVersion} carries none of the stat names this scorer reads ` +
        `(${yardage.join(', ')}); refusing to publish a capture that would score every ` +
        `player at zero`,
    );
  }

  return Object.values(artifact.players).flatMap((player): ProjectionSnapshot[] => {
    if (player.active === false) return [];
    if (player.byeWeek != null && player.byeWeek === artifact.week) return [];

    const stats = player.stats;
    if (stats === undefined || Object.keys(stats).length === 0) return [];

    const points = Math.round(scoreArtifactStats(stats, scoring) * 100) / 100;
    if (points <= 0) return [];

    return [
      {
        season: artifact.season,
        week: artifact.week,
        playerId: player.playerId,
        source: 'ffe',
        // The version is the comparison's whole point: when the ladder moves,
        // the old rows stay and the new ones sit beside them.
        sourceVersion: artifact.modelVersion,
        points,
        ...(player.p25 === undefined ? {} : { p10: player.p25 }),
        ...(player.p50 === undefined ? {} : { p50: player.p50 }),
        ...(player.p75 === undefined ? {} : { p90: player.p75 }),
        ...(player.sd === undefined ? {} : { stddev: player.sd }),
        scoringKey: key,
        capturedAt,
      },
    ];
  });
};
