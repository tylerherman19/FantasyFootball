import { optimalLineup, asPlayerId, type LineupCandidate, type Position } from '@ffe/core';
import type { LeagueView } from './league-data';
import { LEAGUE_TTL_MS, memoizeSync } from './cache';

/**
 * How strong each team is at each position, relative to this league.
 *
 * Positional strength is meaningless in the abstract: "38 points of running
 * back" is good in one league and thin in another, depending on how many backs
 * start and how deep the pool is. So every figure here is expressed against the
 * distribution of the other teams in the same league, which is the only
 * comparison that decides anything.
 *
 * Counted from starters only. A fourth receiver who never enters the lineup is
 * not strength, and rosters that hoard depth at one position would otherwise
 * look formidable while starting the same three players as everyone else.
 */

export const HEATMAP_POSITIONS: readonly Position[] = ['QB', 'RB', 'WR', 'TE'];

export interface PositionCell {
  readonly position: Position;
  /** Projected starter points from this position, for the coming week. */
  readonly points: number;
  /** 0-1 within this league. 1 is the strongest team at the position. */
  readonly percentile: number;
  /** Rank within the league, 1 = best. */
  readonly rank: number;
}

export interface TeamStrength {
  readonly teamId: string;
  readonly cells: readonly PositionCell[];
}

const computeStrength = (view: LeagueView): TeamStrength[] => {
  const { snapshot, context } = view;
  const week = context.weeks[0];
  const weekly = week === undefined ? undefined : context.pool.get(week);

  if (weekly === undefined) return [];

  /*
   * Starter points by position, from the solved lineup.
   *
   * The lineup solver decides who starts, so flex slots are attributed to the
   * position that actually filled them — which is the honest accounting. A team
   * playing three backs because two flexes went that way *is* strong at running
   * back that week, whatever the nominal slot names say.
   */
  const byTeam = context.teams.map((team) => {
    const candidates: LineupCandidate[] = team.playerIds.flatMap((id) => {
      const projection = weekly.get(id);
      if (projection === undefined || !projection.active) return [];
      return [
        {
          playerId: asPlayerId(String(id)),
          position: projection.position,
          eligiblePositions: projection.eligiblePositions,
          projectedPoints: projection.mean,
          stddev: projection.sd,
        },
      ];
    });

    const lineup = optimalLineup(candidates, team.rosterSlots);
    const positionOf = new Map(candidates.map((c) => [String(c.playerId), c.position]));

    const points = new Map<Position, number>();
    for (const slot of lineup.slots) {
      if (slot.playerId === null) continue;
      const position = positionOf.get(String(slot.playerId));
      if (position === undefined) continue;
      points.set(position, (points.get(position) ?? 0) + slot.projectedPoints);
    }

    return { teamId: team.teamId, points };
  });

  // Rank within each position across the league.
  return byTeam.map(({ teamId, points }) => ({
    teamId,
    cells: HEATMAP_POSITIONS.map((position) => {
      const mine = points.get(position) ?? 0;
      const all = byTeam.map((team) => team.points.get(position) ?? 0);
      const sorted = [...all].sort((a, b) => b - a);

      const rank = sorted.findIndex((value) => value <= mine) + 1;
      const below = all.filter((value) => value < mine).length;

      return {
        position,
        points: mine,
        // Share of the league this team is strictly better than, so identical
        // rosters land together rather than being split by tie-break order.
        percentile: all.length <= 1 ? 0.5 : below / (all.length - 1),
        rank: rank === 0 ? all.length : rank,
      };
    }),
  }));
};

export const positionalStrength = memoizeSync(
  computeStrength,
  (view) => `${view.snapshot.league.id}:${view.snapshot.asOfWeek}`,
  LEAGUE_TTL_MS,
  'positional-strength',
);
