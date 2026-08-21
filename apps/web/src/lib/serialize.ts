import type { LeagueView } from './league-data';
import type { MarketValue } from './values';

/**
 * Ship the league to the browser so evaluation is instant.
 *
 * A trade builder is only useful if it responds while you are still thinking.
 * Every change of selection is a fresh simulation, and a server round-trip per
 * keystroke would make it unusable — so the engine, which is pure TypeScript
 * with no Node dependencies, runs in a Web Worker on the client instead.
 *
 * Only rostered players are sent: ten teams of roughly twenty-five is a couple
 * of hundred records, not the two thousand in the full projection set.
 */

export interface WirePlayer {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly mean: number;
  readonly sd: number;
  readonly gameId: string;
  readonly gameLoading: number;
  readonly active: boolean;
  /**
   * The week this player's team does not play, or null if none is known.
   *
   * Carried onto the wire because the browser what-if simulation builds its own
   * weekly pool and would otherwise have no bye information at all — playing
   * everyone every week, including their own bye.
   */
  readonly byeWeek: number | null;
  readonly value: number;
  /** False when the model has no projection for this player at all. */
  readonly projected: boolean;
}

export interface WirePick {
  readonly id: string;
  readonly description: string;
  readonly season: number;
  readonly round: number;
  readonly ownerTeamId: string;
  readonly value: number;
}

export interface WireTeam {
  readonly teamId: string;
  readonly name: string;
  readonly playerIds: readonly string[];
  readonly lineupEfficiency: number;
  readonly isMine: boolean;
}

export interface WireLeague {
  readonly leagueId: string;
  readonly name: string;
  readonly format: string;
  readonly rosterSlots: readonly string[];
  readonly playoffTeams: number;
  readonly regularSeasonWeeks: number;
  readonly medianWins: boolean;
  readonly asOfWeek: number;
  readonly weeks: readonly number[];
  readonly seed: number;
  readonly teams: readonly WireTeam[];
  readonly players: Readonly<Record<string, WirePlayer>>;
  /**
   * Tradeable draft picks, priced against the projected finish of the team that
   * will produce them. Empty in redraft leagues, where picks don't exist as
   * assets.
   */
  readonly picks: readonly WirePick[];
  /**
   * Best available free agents, already filtered.
   *
   * Only players who could plausibly crack a lineup are sent — the rest of the
   * wire cannot change anyone's odds, so shipping them would cost bandwidth to
   * simulate nothing.
   */
  readonly freeAgents: readonly WirePlayer[];
  readonly waiverType: 'faab' | 'priority';
  readonly remainingBudget: number;
  readonly seasonBudget: number;
  readonly weeksRemaining: number;
  /** Snapshot pieces the simulator needs, kept minimal. */
  readonly schedule: readonly {
    week: number;
    matchupId: string;
    teamIds: readonly [string, string];
  }[];
  readonly records: readonly {
    teamId: string;
    wins: number;
    losses: number;
    ties: number;
    pointsFor: number;
  }[];
}

export const serializeLeague = (
  view: LeagueView,
  values: ReadonlyMap<string, MarketValue>,
  playerNames: Record<string, { name: string; position: string; team: string; byeWeek?: number | null }>,
  picks: readonly WirePick[] = [],
  freeAgents: readonly WirePlayer[] = [],
  waivers: { remainingBudget: number; seasonBudget: number } = { remainingBudget: 0, seasonBudget: 0 },
): WireLeague => {
  const { snapshot, context } = view;

  const rostered = new Set<string>();
  for (const team of context.teams) {
    for (const id of team.playerIds) rostered.add(String(id));
  }

  const weekly = context.pool.get(snapshot.asOfWeek);
  const players: Record<string, WirePlayer> = {};

  for (const id of rostered) {
    const projection = weekly?.get(id as never);
    const info = playerNames[id];

    players[id] = {
      id,
      name: info?.name ?? id,
      position: info?.position ?? projection?.position ?? '?',
      team: info?.team ?? '',
      mean: projection?.mean ?? 0,
      /*
       * Whether the model has a projection at all.
       *
       * A rookie has no NFL snaps, so he is absent from the artifact and `mean`
       * falls back to zero. That is "we don't know", not "he will score
       * nothing" — and conflating the two made the waiver board nominate a
       * manager's best rookies as the obvious players to cut.
       */
      projected: projection !== undefined,
      sd: projection?.sd ?? 0,
      gameId: projection?.gameId ?? `none-${id}`,
      gameLoading: projection?.gameLoading ?? 0.3,
      active: projection?.active ?? false,
      byeWeek: info?.byeWeek ?? null,
      value: values.get(id)?.value ?? 0,
    };
  }

  return {
    leagueId: snapshot.league.platformLeagueId,
    name: snapshot.league.name,
    format: snapshot.league.format,
    rosterSlots: [...snapshot.league.rosterSlots],
    playoffTeams: snapshot.league.playoffTeams,
    regularSeasonWeeks: snapshot.league.regularSeasonWeeks,
    medianWins: snapshot.league.medianWins,
    asOfWeek: snapshot.asOfWeek,
    weeks: [...context.weeks],
    seed: context.seed ?? 0,
    teams: context.teams.map((team) => ({
      teamId: team.teamId,
      name: view.teamNames.get(team.teamId) ?? team.teamId,
      playerIds: team.playerIds.map(String),
      lineupEfficiency: team.lineupEfficiency,
      isMine: team.teamId === view.myTeamId,
    })),
    players,
    picks,
    freeAgents,
    waiverType: snapshot.league.waiverType,
    remainingBudget: waivers.remainingBudget,
    seasonBudget: waivers.seasonBudget,
    weeksRemaining: Math.max(1, snapshot.league.regularSeasonWeeks - snapshot.asOfWeek + 1),
    schedule: snapshot.schedule
      .filter((m) => m.week >= snapshot.asOfWeek)
      .map((m) => ({ week: m.week, matchupId: m.matchupId, teamIds: m.teamIds as [string, string] })),
    records: snapshot.records.map((r) => ({
      teamId: r.teamId,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
      pointsFor: r.pointsFor,
    })),
  };
};
