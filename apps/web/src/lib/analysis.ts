import { optimalLineup, projectTeamWeek, type Matchup } from '@ffe/core';
import type { LeagueView } from './league-data';

/**
 * Week-level analysis: how likely each remaining game is, and which ones matter.
 *
 * Win probability is computed analytically rather than by simulation. Two teams'
 * weekly totals are sums of many player draws, so each is close to normal, and
 *
 *   P(A beats B) = Phi( (muA - muB) / sqrt(sdA^2 + sdB^2) )
 *
 * is both accurate and free. Spending 4,000 simulated seasons to learn a single
 * game's odds would be wasteful when the closed form is available.
 *
 * Leverage is different and genuinely needs simulation: "how much does this game
 * change my season" can only be answered by replaying the season both ways.
 */

const normalCdf = (z: number): number => {
  // Abramowitz-Stegun 7.1.26: accurate to ~1e-7, which is far beyond what our
  // inputs justify.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
};

export interface TeamWeekStrength {
  readonly mean: number;
  readonly sd: number;
}

/** Projected total and spread for one team in one week, using its best lineup. */
export const teamWeekStrength = (view: LeagueView, teamId: string, week: number): TeamWeekStrength => {
  const team = view.context.teams.find((t) => t.teamId === teamId);
  if (team === undefined) return { mean: 0, sd: 1 };

  const projection = projectTeamWeek(team, view.context.pool, week);
  const mean = projection.players.reduce((sum, p) => sum + p.mean, 0) * projection.lineupEfficiency;

  // Players correlate through shared games, so variances do not simply add.
  // Adding the shared component separately keeps the spread honest.
  const independent = projection.players.reduce((sum, p) => sum + p.sd ** 2 * (1 - p.gameLoading), 0);
  const shared = projection.players.reduce((sum, p) => sum + p.sd * Math.sqrt(p.gameLoading), 0) ** 2;

  return { mean, sd: Math.sqrt(independent + shared) || 1 };
};

export const winProbability = (a: TeamWeekStrength, b: TeamWeekStrength): number =>
  normalCdf((a.mean - b.mean) / Math.sqrt(a.sd ** 2 + b.sd ** 2 || 1));

export interface ScheduledGame {
  readonly week: number;
  readonly matchupId: string;
  readonly opponentTeamId: string;
  readonly opponentName: string;
  readonly winProbability: number;
  readonly projectedFor: number;
  readonly projectedAgainst: number;
}

export const remainingSchedule = (view: LeagueView, teamId: string): ScheduledGame[] => {
  const { snapshot } = view;

  return snapshot.schedule
    .filter((m: Matchup) => m.week >= snapshot.asOfWeek && m.teamIds.includes(teamId))
    .sort((a, b) => a.week - b.week)
    .map((matchup) => {
      const opponentTeamId = matchup.teamIds[0] === teamId ? matchup.teamIds[1] : matchup.teamIds[0];
      const mine = teamWeekStrength(view, teamId, matchup.week);
      const theirs = teamWeekStrength(view, opponentTeamId, matchup.week);

      return {
        week: matchup.week,
        matchupId: matchup.matchupId,
        opponentTeamId,
        opponentName: view.teamNames.get(opponentTeamId) ?? opponentTeamId,
        winProbability: winProbability(mine, theirs),
        projectedFor: mine.mean,
        projectedAgainst: theirs.mean,
      };
    });
};

export interface Leverage {
  readonly matchupId: string;
  readonly week: number;
  readonly description: string;
  /** Just the other side, for chart labels that have no room for a sentence. */
  readonly opponentName: string;
  readonly isMine: boolean;
  readonly playoffIfWin: number;
  readonly playoffIfLose: number;
  readonly swing: number;
}

/**
 * How much this week's games move your season.
 *
 * Every game replayed both ways, and the difference in your playoff odds is
 * what that result is worth to you. This is what turns "root for whoever" into
 * a ranked list.
 *
 * The simulator prices all of them during the season run the page already
 * needed, so this is now formatting rather than computation — it used to cost
 * two full re-simulations per game, which on a six-game week was more work than
 * everything else on the page combined.
 */
export const weekLeverage = (view: LeagueView, teamId: string, week: number, limit = 6): Leverage[] => {
  const priced = view.result.leverage ?? [];
  if (priced.length === 0 || view.snapshot.asOfWeek !== week) return [];

  return priced
    .map((game) => {
      const [a, b] = game.teamIds;
      const nameA = view.teamNames.get(a) ?? a;
      const nameB = view.teamNames.get(b) ?? b;
      const [ifA, ifB] = game.playoffPctIfWins;

      const isMine = a === teamId || b === teamId;
      const myWin = a === teamId ? ifA : b === teamId ? ifB : Math.max(ifA, ifB);
      const myLoss = a === teamId ? ifB : b === teamId ? ifA : Math.min(ifA, ifB);

      const rootFor = ifA >= ifB ? nameA : nameB;
      const against = ifA >= ifB ? nameB : nameA;

      return {
        matchupId: game.matchupId,
        week,
        description: isMine ? `Your game vs ${a === teamId ? nameB : nameA}` : `Root for ${rootFor} over ${against}`,
        opponentName: isMine ? (a === teamId ? nameB : nameA) : `${rootFor} over ${against}`,
        isMine,
        playoffIfWin: myWin,
        playoffIfLose: myLoss,
        swing: Math.abs(myWin - myLoss),
      };
    })
    .sort((x, y) => y.swing - x.swing)
    .slice(0, limit);
};

export interface RosterEntry {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly mean: number;
  readonly sd: number;
  readonly starting: boolean;
  readonly slot: string | null;
  readonly projected: boolean;
}

/** Roster with the optimal lineup marked, which is also the start/sit answer. */
export const rosterWithLineup = (
  view: LeagueView,
  teamId: string,
  players: Record<string, { name: string; position: string; team: string; mean: number; sd: number; projected: boolean }>,
): RosterEntry[] => {
  const team = view.context.teams.find((t) => t.teamId === teamId);
  if (team === undefined) return [];

  const week = view.snapshot.asOfWeek;
  const weekly = view.context.pool.get(week);

  const candidates = team.playerIds
    .map((id) => weekly?.get(id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined && p.active)
    .map((p) => ({
      playerId: p.playerId,
      position: p.position,
      eligiblePositions: p.eligiblePositions,
      projectedPoints: p.mean,
      stddev: p.sd,
    }));

  const lineup = optimalLineup(candidates, view.snapshot.league.rosterSlots);
  const slotByPlayer = new Map<string, string>();
  for (const slot of lineup.slots) {
    if (slot.playerId !== null) slotByPlayer.set(String(slot.playerId), slot.slot);
  }

  return team.playerIds
    .map((id): RosterEntry => {
      const key = String(id);
      const info = players[key];
      const projection = weekly?.get(id);

      return {
        playerId: key,
        name: info?.name ?? key,
        position: info?.position ?? projection?.position ?? '?',
        team: info?.team ?? '',
        mean: projection?.mean ?? 0,
        sd: projection?.sd ?? 0,
        starting: slotByPlayer.has(key),
        slot: slotByPlayer.get(key) ?? null,
        projected: info?.projected ?? projection !== undefined,
      };
    })
    .sort((a, b) => Number(b.starting) - Number(a.starting) || b.mean - a.mean);
};
