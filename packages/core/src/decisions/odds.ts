import type { LeagueSnapshot, PlayerId } from '../domain/index.js';
import { simulateSeason, type SeasonSimResult } from '../sim/season.js';
import {
  projectTeamWeek,
  withRosterChange,
  type ProjectionPool,
  type TeamContext,
} from '../sim/roster-projection.js';
import type { TeamWeekProjection } from '../sim/season.js';

/**
 * Per-team projection cache.
 *
 * A trade or waiver evaluation changes one or two rosters and leaves the other
 * eight untouched, yet the naive path re-derives every team's optimal lineup for
 * every remaining week on both sides of every comparison. Since unchanged teams
 * are passed through by reference, a WeakMap keyed on the team object skips all
 * of that — and the entries disappear on their own when the context does.
 */
const teamProjectionCache = new WeakMap<TeamContext, Map<string, TeamWeekProjection[]>>();

const projectTeam = (
  team: TeamContext,
  pool: ProjectionPool,
  weeks: readonly number[],
): TeamWeekProjection[] => {
  const key = weeks.join(',');
  const cached = teamProjectionCache.get(team);
  const hit = cached?.get(key);
  if (hit !== undefined) return hit;

  const projections = weeks.map((week) => projectTeamWeek(team, pool, week));
  const byWeeks = cached ?? new Map<string, TeamWeekProjection[]>();
  byWeeks.set(key, projections);
  teamProjectionCache.set(team, byWeeks);

  return projections;
};

const projectAll = (
  teams: readonly TeamContext[],
  pool: ProjectionPool,
  weeks: readonly number[],
): TeamWeekProjection[] => teams.flatMap((team) => projectTeam(team, pool, weeks));

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

/**
 * Simulated seasons, cached per context.
 *
 * Evaluating one trade asks for the same season four times: a baseline for each
 * side, then the post-trade world for each side. Three of those four are
 * identical to something already computed — the baseline never changes, and
 * both sides look at the *same* post-trade world. Screening ten candidate
 * trades therefore ran forty simulations to learn eleven things.
 *
 * Keyed on the context object, so entries vanish with it, and by the exact
 * roster change so two different questions never collide. Contexts are readonly
 * by type; a caller that mutates one in place would see a stale answer, which
 * is why they aren't meant to be mutated.
 */
const resultCache = new WeakMap<SimContext, Map<string, SeasonSimResult>>();

/** A stable name for one set of roster changes. Order must not matter. */
const changeKey = (changes: readonly RosterChange[]): string =>
  changes
    .map(
      (change) =>
        `${change.teamId}+${[...(change.add ?? [])].sort().join('.')}-${[...(change.drop ?? [])].sort().join('.')}`,
    )
    .sort()
    .join('|');

const simulateCached = (
  context: SimContext,
  changes: readonly RosterChange[],
): SeasonSimResult => {
  const iterations = context.iterations ?? 4_000;
  const seed = context.seed ?? 0x5eed;
  const key = `${iterations}:${seed}:${changeKey(changes)}`;

  const byKey = resultCache.get(context) ?? new Map<string, SeasonSimResult>();
  const hit = byKey.get(key);
  if (hit !== undefined) return hit;

  const changeByTeam = new Map(changes.map((change) => [change.teamId, change]));
  const teams =
    changes.length === 0
      ? context.teams
      : context.teams.map((team) => {
          const change = changeByTeam.get(team.teamId);
          if (change === undefined) return team;
          return withRosterChange(team, {
            ...(change.add !== undefined ? { add: change.add } : {}),
            ...(change.drop !== undefined ? { drop: change.drop } : {}),
          });
        });

  const result = simulateSeason({
    snapshot: context.snapshot,
    projections: projectAll(teams, context.pool, context.weeks),
    iterations,
    // Every comparison shares a seed: we are measuring the change, not the
    // noise between two independent runs.
    seed,
  });

  byKey.set(key, result);
  resultCache.set(context, byKey);

  return result;
};

export const extractOdds = (result: SeasonSimResult, teamId: string): OddsSnapshot => {
  const team = result.teams.find((t) => t.teamId === teamId);
  return {
    playoffPct: team?.playoffPct ?? 0,
    titlePct: team?.titlePct ?? 0,
    expectedWins: team?.expectedWins ?? 0,
  };
};

export const currentOdds = (context: SimContext, teamId: string): OddsSnapshot =>
  extractOdds(simulateCached(context, []), teamId);

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
  const baseline = before ?? extractOdds(simulateCached(context, []), forTeamId);
  const after = extractOdds(simulateCached(context, changes), forTeamId);

  return {
    before: baseline,
    after,
    playoffDelta: after.playoffPct - baseline.playoffPct,
    titleDelta: after.titlePct - baseline.titlePct,
    winsDelta: after.expectedWins - baseline.expectedWins,
  };
};
