import type { LineupSlot, PlayerId, Position } from '../domain/index.js';
import { optimalLineup, type LineupCandidate } from './lineup.js';
import type { CorrelatedPlayer } from './correlated.js';
import type { TeamWeekProjection } from './season.js';

/**
 * The bridge between "what we think a player will do" and "what the simulator
 * needs". Every decision in the product runs through here, because a decision
 * *is* a change to a roster followed by a re-simulation.
 */

export interface PlayerProjection {
  readonly playerId: PlayerId;
  readonly position: Position;
  readonly eligiblePositions: readonly Position[];
  readonly mean: number;
  readonly sd: number;
  /** NFL game the player appears in, so teammates and opponents correlate. */
  readonly gameId: string;
  readonly gameLoading: number;
  readonly residuals?: readonly number[];
  /** False when on bye or ruled out — the player contributes nothing that week. */
  readonly active: boolean;
}

/** Weekly projections for every player we know about, keyed by week then player. */
export type ProjectionPool = ReadonlyMap<number, ReadonlyMap<PlayerId, PlayerProjection>>;

export interface TeamContext {
  readonly teamId: string;
  readonly playerIds: readonly PlayerId[];
  readonly rosterSlots: readonly LineupSlot[];
  readonly lineupEfficiency: number;
}

const toCandidate = (projection: PlayerProjection): LineupCandidate => ({
  playerId: projection.playerId,
  position: projection.position,
  eligiblePositions: projection.eligiblePositions,
  projectedPoints: projection.mean,
  stddev: projection.sd,
});

/**
 * Build one team-week for the simulator.
 *
 * Only the optimal starting lineup contributes. Benched players are excluded
 * rather than down-weighted, because a bench player scoring 30 does not help
 * you — which is exactly the distinction lineup efficiency then adjusts for.
 */
export const projectTeamWeek = (
  team: TeamContext,
  pool: ProjectionPool,
  week: number,
): TeamWeekProjection => {
  const weekly = pool.get(week);

  const available = team.playerIds
    .map((id) => weekly?.get(id))
    .filter((p): p is PlayerProjection => p !== undefined && p.active);

  const lineup = optimalLineup(available.map(toCandidate), team.rosterSlots);
  const starters = new Set(
    lineup.slots.map((s) => s.playerId).filter((id): id is PlayerId => id !== null),
  );

  const players: CorrelatedPlayer[] = available
    .filter((p) => starters.has(p.playerId))
    .map((p) => ({
      playerId: p.playerId,
      mean: p.mean,
      sd: p.sd,
      gameId: p.gameId,
      gameLoading: p.gameLoading,
      ...(p.residuals !== undefined ? { residuals: p.residuals } : {}),
    }));

  return {
    teamId: team.teamId,
    week,
    players,
    lineupEfficiency: team.lineupEfficiency,
  };
};

/** Every team, every remaining week. */
export const projectSeason = (
  teams: readonly TeamContext[],
  pool: ProjectionPool,
  weeks: readonly number[],
): TeamWeekProjection[] =>
  weeks.flatMap((week) => teams.map((team) => projectTeamWeek(team, pool, week)));

/**
 * Apply a roster change without mutating the original.
 *
 * Used by every what-if in the product: adding a waiver claim, executing a
 * trade, or dropping a player are all this function plus a re-simulation.
 */
export const withRosterChange = (
  team: TeamContext,
  { add = [], drop = [] }: { add?: readonly PlayerId[]; drop?: readonly PlayerId[] },
): TeamContext => {
  const dropped = new Set(drop);
  const remaining = team.playerIds.filter((id) => !dropped.has(id));
  const existing = new Set(remaining);

  return {
    ...team,
    playerIds: [...remaining, ...add.filter((id) => !existing.has(id))],
  };
};
