import {
  asPlayerId,
  powerRankings,
  replacementLevels,
  scheduleLuck,
  teamScarcity,
  type Position,
  type ScarcityPlayer,
  type ScheduleLuck,
  type TeamRanking,
  type TeamScarcity,
} from '@ffe/core';
import type { LeagueView } from './league-data';
import { loadMarketValues } from './values';
import type { PlayerInfo } from './players';

/**
 * Assembles the three-way ranking for a league.
 *
 * The simulation already knows projected wins and title odds. Market value is
 * the one input we cannot produce ourselves — it is the league's collective
 * opinion rather than ours — so it comes from FantasyCalc, and when that call
 * fails the page degrades to a two-way ranking instead of inventing prices.
 */

export interface RankedTeam {
  readonly teamId: string;
  readonly teamName: string;
  readonly ranking: TeamRanking;
  readonly luck: ScheduleLuck | null;
  readonly scarcity: TeamScarcity;
  readonly efficiency: number;
  readonly pointsLost: number;
  readonly efficiencyImputed: boolean;
}

export interface LeagueRankings {
  readonly teams: readonly RankedTeam[];
  /**
   * False when the market told us nothing — either FantasyCalc was unreachable,
   * or the league has not drafted and every roster is worth the same zero.
   */
  readonly hasMarketValues: boolean;
  /** True before the draft, when there is nothing on any roster to rank. */
  readonly notDrafted: boolean;
  readonly replacement: ReadonlyMap<Position, number>;
}

/** Everyone rostered anywhere in the league, as scarcity inputs. */
const leaguePool = (
  view: LeagueView,
  players: Record<string, PlayerInfo>,
): ScarcityPlayer[] =>
  view.snapshot.rosters.flatMap((roster) =>
    roster.playerIds.flatMap((playerId): ScarcityPlayer[] => {
      const key = String(playerId);
      const info = players[key];
      if (info === undefined || !info.projected) return [];

      const position = info.position as Position;
      return [
        {
          playerId: asPlayerId(key),
          position,
          eligiblePositions: [position],
          points: info.mean,
        },
      ];
    }),
  );

export const leagueRankings = async (
  view: LeagueView,
  players: Record<string, PlayerInfo>,
): Promise<LeagueRankings> => {
  const { snapshot, result, teamNames, efficiencies } = view;

  const market = await loadMarketValues(snapshot.league.format, snapshot.league.superFlex);

  const pool = leaguePool(view, players);
  const levels = replacementLevels(pool, snapshot.league.rosterSlots, snapshot.league.teamCount);
  const luck = scheduleLuck(snapshot);

  const byTeam = new Map(pool.map((p) => [String(p.playerId), p]));

  const rankings = powerRankings(
    snapshot.rosters.map((roster) => {
      const outcome = result.teams.find((t) => t.teamId === roster.teamId);

      return {
        teamId: roster.teamId,
        marketValue: roster.playerIds.reduce(
          (sum, playerId) => sum + (market.get(String(playerId))?.value ?? 0),
          0,
        ),
        expectedWins: outcome?.expectedWins ?? 0,
        titlePct: outcome?.titlePct ?? 0,
        playoffPct: outcome?.playoffPct ?? 0,
      };
    }),
  );

  const teams = rankings.map((ranking): RankedTeam => {
    const roster = snapshot.rosters.find((r) => r.teamId === ranking.teamId);
    const rosterPlayers = (roster?.playerIds ?? []).flatMap((playerId) => {
      const player = byTeam.get(String(playerId));
      return player === undefined ? [] : [player];
    });

    const efficiency = efficiencies.get(ranking.teamId);

    return {
      teamId: ranking.teamId,
      teamName: teamNames.get(ranking.teamId) ?? ranking.teamId,
      ranking,
      luck: luck.get(ranking.teamId) ?? null,
      scarcity: teamScarcity(ranking.teamId, rosterPlayers, levels, snapshot.league.rosterSlots),
      efficiency: efficiency?.efficiency ?? 0,
      pointsLost: efficiency?.pointsLost ?? 0,
      efficiencyImputed: efficiency?.imputed ?? true,
    };
  });

  // A market that priced nothing on any roster is no market at all — showing a
  // column of zeros and the ranks derived from it would be worse than omitting
  // it, because the ranks look authoritative.
  const pricedValue = rankings.reduce((sum, r) => sum + r.marketValue, 0);

  return {
    teams,
    hasMarketValues: market.size > 0 && pricedValue > 0,
    notDrafted: snapshot.rosters.every((roster) => roster.playerIds.length === 0),
    replacement: new Map([...levels].map(([position, level]) => [position, level.points])),
  };
};
