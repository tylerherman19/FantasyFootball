import type { LeagueSnapshot, PlayerId, Position } from '../domain/index.js';
import { optimalLineup, type LineupCandidate } from '../sim/lineup.js';

/**
 * Measured lineup efficiency, per manager.
 *
 * How close each manager gets to their optimal lineup is a real, persistent
 * skill difference, and it has to be measured rather than assumed. Simulating
 * everyone as a perfect optimizer overrates deep benches nobody starts;
 * applying one flat number to everyone erases the difference between the
 * manager who sets his lineup Sunday morning and the one who forgets.
 *
 * Computed from what actually happened: for each played week, what the roster
 * scored versus what its best legal lineup would have scored.
 */

export interface EfficiencyResult {
  readonly teamId: string;
  readonly efficiency: number;
  readonly weeksMeasured: number;
  /** Points left on the bench across the measured weeks. */
  readonly pointsLost: number;
  /** True when we fell back to the league average for lack of history. */
  readonly imputed: boolean;
}

/** Below this many played weeks, a manager's own number is mostly noise. */
const MIN_WEEKS = 3;

/**
 * League-average efficiency used before enough games exist to measure.
 *
 * Not a guess about a particular manager — it is what this league itself has
 * done, and only falls back to a literature-typical value when the league has
 * no history at all (a brand new league in week 1).
 */
const FALLBACK_EFFICIENCY = 0.93;

export const lineupEfficiencies = (
  snapshot: LeagueSnapshot,
  positionOf: (playerId: PlayerId) => Position | null,
): Map<string, EfficiencyResult> => {
  const perTeam = new Map<string, { actual: number; optimal: number; weeks: number }>();

  const rosterByTeam = new Map(snapshot.rosters.map((r) => [r.teamId, r]));

  for (const score of snapshot.weeklyScores) {
    if (!score.played) continue;

    const roster = rosterByTeam.get(score.teamId);
    if (roster === undefined) continue;

    const scored = Object.entries(score.playerPoints);
    if (scored.length === 0) continue;

    // Everyone who scored that week is a candidate; the solver decides who the
    // best legal lineup would have been.
    const candidates: LineupCandidate[] = scored.flatMap(([playerId, points]) => {
      const position = positionOf(playerId as PlayerId);
      if (position === null) return [];
      return [
        {
          playerId: playerId as PlayerId,
          position,
          eligiblePositions: [position],
          projectedPoints: points,
          stddev: 0,
        },
      ];
    });

    if (candidates.length === 0) continue;

    const best = optimalLineup(candidates, snapshot.league.rosterSlots);
    if (best.totalProjected <= 0) continue;

    const existing = perTeam.get(score.teamId) ?? { actual: 0, optimal: 0, weeks: 0 };
    perTeam.set(score.teamId, {
      actual: existing.actual + score.points,
      optimal: existing.optimal + best.totalProjected,
      weeks: existing.weeks + 1,
    });
  }

  // League average across managers who have enough history to contribute.
  const measured = [...perTeam.values()].filter((t) => t.weeks >= MIN_WEEKS);
  const leagueAverage =
    measured.length > 0
      ? measured.reduce((sum, t) => sum + t.actual, 0) / measured.reduce((sum, t) => sum + t.optimal, 0)
      : FALLBACK_EFFICIENCY;

  const out = new Map<string, EfficiencyResult>();

  for (const roster of snapshot.rosters) {
    const totals = perTeam.get(roster.teamId);

    if (totals === undefined || totals.weeks < MIN_WEEKS || totals.optimal <= 0) {
      out.set(roster.teamId, {
        teamId: roster.teamId,
        efficiency: leagueAverage,
        weeksMeasured: totals?.weeks ?? 0,
        pointsLost: totals === undefined ? 0 : Math.max(0, totals.optimal - totals.actual),
        imputed: true,
      });
      continue;
    }

    out.set(roster.teamId, {
      teamId: roster.teamId,
      // A manager cannot exceed their optimal lineup; clamp against scoring
      // corrections that would otherwise push the ratio above one.
      efficiency: Math.min(1, totals.actual / totals.optimal),
      weeksMeasured: totals.weeks,
      pointsLost: Math.max(0, totals.optimal - totals.actual),
      imputed: false,
    });
  }

  return out;
};
