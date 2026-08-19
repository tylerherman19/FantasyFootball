import { loadDefenses, matchupFor, opponentFrom } from './defense';
import { buildTeamProfiles } from './league-analytics';
import { loadLeague } from './league-data';
import { buildUsage } from './usage';
import { loadMarketValues } from './values';

/**
 * Everything one league looks like, frozen into a single JSON payload.
 *
 * The app is server-rendered because it simulates a season on every cold load,
 * which is not something a static page can do. But once that simulation has
 * run its *output* is small — a few hundred kilobytes covering every number on
 * every page — and a page holding that output needs no server at all.
 *
 * That is what this produces: a snapshot that can be inlined into a standalone
 * page and browsed with zero network requests and zero latency. Same numbers
 * the live app computes, taken at one moment in time.
 *
 * Keys are short on purpose. This is machine-read by one known consumer and the
 * payload travels inside the HTML document, so a third of the bytes being the
 * word "opportunities" repeated four hundred times is a real cost.
 */

export interface StaticSite {
  readonly generatedAt: string;
  readonly league: Readonly<Record<string, unknown>>;
  readonly iterations: number;
  readonly modelVersion: string | null;
  readonly myTeamId: string | null;
  readonly teams: readonly unknown[];
  readonly players: readonly unknown[];
  readonly offenses: readonly unknown[];
  readonly defenses: readonly unknown[];
  readonly matchups: readonly unknown[];
  readonly rosters: Readonly<Record<string, readonly string[]>>;
  readonly leverage: readonly unknown[];
  readonly defenseMeta: { readonly seasons: readonly number[]; readonly version: string } | null;
}

const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

export const buildStaticSite = async (leagueId: string, username: string): Promise<StaticSite> => {
  const view = await loadLeague(leagueId, username);
  const { snapshot } = view;

  const [profiles, usage, defenses, values] = await Promise.all([
    buildTeamProfiles(view),
    buildUsage(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
    loadDefenses(),
    loadMarketValues(snapshot.league.format, snapshot.league.superFlex),
  ]);

  const allDefenses = defenses === null ? [] : Object.values(defenses.teams);

  // Only players worth drawing. The artifact carries 2,313, most of whom are
  // third-string defensive backs nobody will ever filter for.
  const relevant = usage.players
    .filter((player) => player.active && player.points >= 3)
    .sort((a, b) => b.points - a.points)
    .slice(0, 420);

  const chosen = new Set(relevant.map((player) => player.playerId));
  const rostered = new Set(snapshot.rosters.flatMap((roster) => roster.playerIds.map(String)));

  // Anyone rostered in this league belongs in the payload even if he projects
  // badly — leaving him out would make his own manager's roster wrong.
  const included = [
    ...relevant,
    ...usage.players.filter((player) => rostered.has(player.playerId) && !chosen.has(player.playerId)),
  ];

  const players = included.map((player) => ({
    id: player.playerId,
    n: player.name,
    p: player.position,
    t: player.team,
    g: player.gameId,
    pts: round(player.points, 1),
    opp: round(player.opportunities, 1),
    car: round(player.carries, 1),
    tgt: round(player.targets, 1),
    rec: round(player.receptions, 1),
    yds: Math.round(player.yardsFromScrimmage),
    ts: round(player.targetShare, 3),
    cs: round(player.carryShare, 3),
    td: round(player.tdDependence, 2),
    sd: round(player.sd, 1),
    ypt: player.yardsPerTarget === null ? null : round(player.yardsPerTarget, 1),
    ypc: player.yardsPerCarry === null ? null : round(player.yardsPerCarry, 1),
    ppo: player.pointsPerOpportunity === null ? null : round(player.pointsPerOpportunity, 2),
    mv: values.get(player.playerId)?.value ?? 0,
  }));

  const matchups =
    defenses === null
      ? []
      : included.flatMap((player) => {
          if (!['QB', 'RB', 'WR', 'TE'].includes(player.position)) return [];

          const opponent = opponentFrom(player.gameId, player.team);
          const defense = opponent === null ? undefined : defenses.teams[opponent];
          if (defense === undefined || opponent === null) return [];

          const effect = matchupFor(player.position, defense, allDefenses);
          return [
            {
              id: player.playerId,
              opp: opponent,
              score: round(effect.score, 2),
              headline: effect.headline,
              detail: effect.detail,
            },
          ];
        });

  return {
    generatedAt: new Date().toISOString(),
    league: {
      name: snapshot.league.name,
      format: snapshot.league.format,
      teamCount: snapshot.league.teamCount,
      season: snapshot.league.season,
      week: snapshot.asOfWeek,
      playoffTeams: snapshot.league.playoffTeams,
      regularSeasonWeeks: snapshot.league.regularSeasonWeeks,
      superFlex: snapshot.league.superFlex,
      medianWins: snapshot.league.medianWins,
      rosterSlots: snapshot.league.rosterSlots,
    },
    iterations: view.result.iterations,
    modelVersion: view.modelVersion,
    myTeamId: view.myTeamId,
    teams: profiles.map((profile) => ({
      id: profile.teamId,
      name: profile.name,
      mine: profile.isMine,
      start: round(profile.starterPoints, 1),
      bench: round(profile.benchPoints, 1),
      value: profile.marketValue,
      playoff: round(profile.playoffPct, 3),
      title: round(profile.titlePct, 3),
      wins: round(profile.expectedWins, 1),
      rankDist: profile.rankDistribution.map((v) => round(v, 3)),
      winDist: profile.winDistribution.map((v) => round(v, 3)),
      age: profile.averageAge === null ? null : round(profile.averageAge, 1),
      size: profile.rosterSize,
      topTwo: round(profile.topTwoShare, 2),
      eff: round(profile.lineupEfficiency, 3),
      byPos: profile.byPosition.map((slice) => ({
        p: slice.position,
        start: round(slice.starterPoints, 1),
        rank: slice.rank,
        strength: round(slice.strength, 2),
        count: slice.count,
      })),
    })),
    players,
    offenses: usage.offenses.map((offense) => ({
      t: offense.team,
      passRate: round(offense.passRate, 3),
      plays: Math.round(offense.plays),
      conc: round(offense.targetConcentration, 3),
      top: offense.topTargetName,
      topShare: round(offense.topTargetShare, 3),
    })),
    defenses: allDefenses.map((defense) => ({
      t: defense.team,
      shell: defense.shellIndex,
      pressure: defense.pressureIndex,
      adot: defense.adotAllowed,
      deep: defense.deepRateAllowed,
      yac: defense.yacShareAllowed,
      comp: defense.completionRateAllowed,
      ypa: defense.ypaAllowed,
      sack: defense.sackRate,
      hit: defense.qbHitRate,
      int: defense.intRate,
      ypc: defense.ypcAllowed,
      xrush: defense.explosiveRushRateAllowed,
      xpass: defense.explosivePassRateAllowed,
      passEpa: defense.passEpaAdjusted,
      rushEpa: defense.rushEpaAdjusted,
      tgt: defense.targetShareAllowed,
    })),
    matchups,
    rosters: Object.fromEntries(
      snapshot.rosters.map((roster) => [roster.teamId, roster.playerIds.map(String)]),
    ),
    leverage: (view.result.leverage ?? []).map((game) => ({
      id: game.matchupId,
      teams: game.teamIds,
      odds: game.playoffPctIfWins.map((v) => round(v, 3)),
    })),
    defenseMeta:
      defenses === null ? null : { seasons: defenses.seasons, version: defenses.modelVersion },
  };
};
