import type { LeagueSnapshot, PlayerId } from '../domain/index.js';
import { simulateSeason, type SeasonSimResult } from '../sim/season.js';
import {
  projectSeason,
  withRosterChange,
  type ProjectionPool,
  type TeamContext,
} from '../sim/roster-projection.js';

/**
 * The single currency.
 *
 * Every decision this product makes is priced the same way: simulate the season
 * as it stands, simulate it again with the change applied, and report the
 * difference in championship probability. Not "trade value points", not a
 * projection delta — the actual change in your odds of winning the league.
 *
 * This is what lets a waiver claim, a start/sit call and a three-player trade
 * be compared on one scale, which is the thing no existing tool does.
 */

export interface OddsSnapshot {
  readonly playoffPct: number;
  readonly titlePct: number;
  readonly expectedWins: number;
}

export interface OddsDelta {
  readonly before: OddsSnapshot;
  readonly after: OddsSnapshot;
  readonly playoffDelta: number;
  readonly titleDelta: number;
  readonly winsDelta: number;
}

export interface SimContext {
  readonly snapshot: LeagueSnapshot;
  readonly teams: readonly TeamContext[];
  readonly pool: ProjectionPool;
  readonly weeks: readonly number[];
  /**
   * Iterations per evaluation. The default trades a little precision for
   * responsiveness; final answers re-run at full count.
   */
  readonly iterations?: number;
  /**
   * Fixed seed. Critical for comparisons: two simulations differing only in the
   * roster change must share randomness, or the noise between them swamps the
   * signal being measured.
   */
  readonly seed?: number;
}

export const extractOdds = (result: SeasonSimResult, teamId: string): OddsSnapshot => {
  const team = result.teams.find((t) => t.teamId === teamId);
  return {
    playoffPct: team?.playoffPct ?? 0,
    titlePct: team?.titlePct ?? 0,
    expectedWins: team?.expectedWins ?? 0,
  };
};

export const currentOdds = (context: SimContext, teamId: string): OddsSnapshot => {
  const result = simulateSeason({
    snapshot: context.snapshot,
    projections: projectSeason(context.teams, context.pool, context.weeks),
    iterations: context.iterations ?? 4_000,
    seed: context.seed ?? 0x5eed,
  });
  return extractOdds(result, teamId);
};

export interface RosterChange {
  readonly teamId: string;
  readonly add?: readonly PlayerId[];
  readonly drop?: readonly PlayerId[];
}

/**
 * Odds impact of one or more roster changes, applied simultaneously.
 *
 * A trade is two changes at once — one per side — which is why this takes a
 * list rather than a single change.
 */
export const oddsDelta = (
  context: SimContext,
  changes: readonly RosterChange[],
  forTeamId: string,
  before?: OddsSnapshot,
): OddsDelta => {
  const seed = context.seed ?? 0x5eed;
  const iterations = context.iterations ?? 4_000;

  const baseline =
    before ??
    extractOdds(
      simulateSeason({
        snapshot: context.snapshot,
        projections: projectSeason(context.teams, context.pool, context.weeks),
        iterations,
        seed,
      }),
      forTeamId,
    );

  const changeByTeam = new Map(changes.map((c) => [c.teamId, c]));
  const modified = context.teams.map((team) => {
    const change = changeByTeam.get(team.teamId);
    if (change === undefined) return team;
    return withRosterChange(team, {
      ...(change.add !== undefined ? { add: change.add } : {}),
      ...(change.drop !== undefined ? { drop: change.drop } : {}),
    });
  });

  const after = extractOdds(
    simulateSeason({
      snapshot: context.snapshot,
      projections: projectSeason(modified, context.pool, context.weeks),
      iterations,
      // Same seed as the baseline: we are measuring the change, not the noise.
      seed,
    }),
    forTeamId,
  );

  return {
    before: baseline,
    after,
    playoffDelta: after.playoffPct - baseline.playoffPct,
    titleDelta: after.titlePct - baseline.titlePct,
    winsDelta: after.expectedWins - baseline.expectedWins,
  };
};
