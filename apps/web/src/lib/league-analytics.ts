import { asPlayerId, optimalLineup, type LineupCandidate, type Position } from '@ffe/core';
import { loadAvailability } from './availability';
import { loadIdentities } from './crosswalk';
import type { LeagueView } from './league-data';
import { loadArtifact, scoreFor } from './projections';
import { loadMarketValues } from './values';

/**
 * The league, measured every way that fits on a page.
 *
 * Everything a manager argues about is comparative — who is deepest at running
 * back, whose roster is oldest, who is carrying the most dead weight, who got
 * the schedule. Each of those is a different projection of the same roster
 * data, so they are all computed here in one pass and handed to the page as
 * plain numbers ready to draw.
 *
 * Two distinctions this insists on, because they are where naive tools go
 * wrong:
 *
 * - **Starters and depth are counted separately.** A bench full of WR4s adds a
 *   great deal to a roster's total value and almost nothing to what it scores
 *   on Sunday. Reporting one number for both is how a hoarder ends up ranked
 *   first.
 * - **Market value and lineup contribution are different currencies.** What a
 *   player is worth in a trade and what he does for *this* lineup diverge
 *   constantly, and the gap between them is the entire buy-low / sell-high
 *   signal — so they are never averaged together.
 */

export interface PositionSlice {
  readonly position: string;
  /** Projected points from this position's players who make the lineup. */
  readonly starterPoints: number;
  /** Projected points from the rest. */
  readonly benchPoints: number;
  readonly marketValue: number;
  readonly count: number;
  /** 1 = best in the league at this position, by starter points. */
  readonly rank: number;
  /** Where this team sits between the league's worst and best, 0-1. */
  readonly strength: number;
}

export interface TeamProfile {
  readonly teamId: string;
  readonly name: string;
  readonly isMine: boolean;

  readonly starterPoints: number;
  readonly benchPoints: number;
  readonly totalPoints: number;
  readonly marketValue: number;
  readonly starterMarketValue: number;

  readonly playoffPct: number;
  readonly titlePct: number;
  readonly expectedWins: number;
  readonly rankDistribution: readonly number[];
  readonly winDistribution: readonly number[];

  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pointsFor: number;
  readonly pointsAgainst: number;

  /** Points scored per completed week, oldest first. */
  readonly weeklyScores: readonly number[];
  /** Measured points-scored / optimal-points ratio, 0-1. */
  readonly lineupEfficiency: number;

  /** Value-weighted, so a 34-year-old QB1 counts more than a 22-year-old WR6. */
  readonly averageAge: number | null;
  readonly rosterSize: number;
  /** Share of starter points coming from the top two players, 0-1. */
  readonly topTwoShare: number;

  readonly byPosition: readonly PositionSlice[];
}

/** Positions worth breaking a roster down by, in the order managers think of them. */
const CORE_POSITIONS: readonly string[] = ['QB', 'RB', 'WR', 'TE'];
const EXTRA_POSITIONS: readonly string[] = ['K', 'DEF', 'DL', 'LB', 'DB'];

interface RatedPlayer {
  readonly playerId: string;
  readonly position: string;
  readonly points: number;
  readonly marketValue: number;
  readonly age: number | null;
  readonly starting: boolean;
}

const ageFrom = (birthdate: string | null): number | null => {
  if (birthdate === null) return null;
  const years = (Date.now() - new Date(birthdate).getTime()) / (365.25 * 24 * 3600 * 1000);
  return Number.isFinite(years) && years > 0 && years < 60 ? years : null;
};

export const buildTeamProfiles = async (view: LeagueView): Promise<TeamProfile[]> => {
  const { snapshot, result, teamNames, myTeamId, efficiencies } = view;

  const [artifact, values, identities, availability] = await Promise.all([
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadMarketValues(snapshot.league.format, snapshot.league.superFlex),
    loadIdentities(),
    loadAvailability(),
  ]);

  const rules = snapshot.league.scoring.raw;
  const outcomes = new Map(result.teams.map((team) => [team.teamId, team]));
  const records = new Map(snapshot.records.map((record) => [record.teamId, record]));

  // Completed weeks only. Sleeper reports zeros for the future, and charting a
  // run of zeros as "recent form" is worse than showing nothing.
  const scoresByTeam = new Map<string, { week: number; points: number }[]>();
  for (const score of snapshot.weeklyScores) {
    if (!score.played) continue;
    const bucket = scoresByTeam.get(score.teamId);
    if (bucket === undefined) scoresByTeam.set(score.teamId, [{ week: score.week, points: score.points }]);
    else bucket.push({ week: score.week, points: score.points });
  }

  const rated = new Map<string, RatedPlayer[]>();

  for (const roster of snapshot.rosters) {
    const candidates: LineupCandidate[] = [];
    const players: Omit<RatedPlayer, 'starting'>[] = [];

    for (const rawId of roster.playerIds) {
      const id = String(rawId);
      const projection = artifact?.players[id];
      const identity = identities[id];

      const points =
        projection === undefined
          ? 0
          : scoreFor(projection, rules, availability[id]?.injuryStatus ?? null);

      const position = projection?.position ?? identity?.position ?? '?';

      players.push({
        playerId: id,
        position,
        points,
        marketValue: values.get(id)?.value ?? 0,
        age: ageFrom(identity?.birthdate ?? null),
      });

      if (projection !== undefined && projection.active) {
        candidates.push({
          playerId: asPlayerId(id),
          position: projection.position as Position,
          eligiblePositions: [projection.position as Position],
          projectedPoints: points,
          stddev: projection.sd,
        });
      }
    }

    // Who actually starts is the solved lineup, not the top N by points —
    // slot eligibility is the whole reason a fourth receiver can be worth less
    // than a second tight end.
    const lineup = optimalLineup(candidates, snapshot.league.rosterSlots);
    const starters = new Set(
      lineup.slots.map((slot) => slot.playerId).filter((id): id is NonNullable<typeof id> => id !== null).map(String),
    );

    rated.set(
      roster.teamId,
      players.map((player) => ({ ...player, starting: starters.has(player.playerId) })),
    );
  }

  // Positional starter points across the league, so each team can be placed
  // against the field rather than against an absolute nobody can calibrate.
  const positionsPresent = [...CORE_POSITIONS, ...EXTRA_POSITIONS].filter((position) =>
    [...rated.values()].some((players) => players.some((player) => player.position === position)),
  );

  const leaguePositionPoints = new Map<string, number[]>();
  for (const position of positionsPresent) {
    leaguePositionPoints.set(
      position,
      [...rated.values()].map((players) =>
        players
          .filter((player) => player.position === position && player.starting)
          .reduce((sum, player) => sum + player.points, 0),
      ),
    );
  }

  return snapshot.rosters.map((roster): TeamProfile => {
    const players = rated.get(roster.teamId) ?? [];
    const starters = players.filter((player) => player.starting);
    const bench = players.filter((player) => !player.starting);

    const starterPoints = starters.reduce((sum, player) => sum + player.points, 0);
    const topTwo = [...starters]
      .sort((a, b) => b.points - a.points)
      .slice(0, 2)
      .reduce((sum, player) => sum + player.points, 0);

    const outcome = outcomes.get(roster.teamId);
    const record = records.get(roster.teamId);

    // Weighted by market value: the average of a roster's ages says little when
    // half of it is deep-bench flyers nobody would trade for.
    const aged = players.filter((player) => player.age !== null && player.marketValue > 0);
    const ageWeight = aged.reduce((sum, player) => sum + player.marketValue, 0);
    const averageAge =
      ageWeight > 0
        ? aged.reduce((sum, player) => sum + (player.age ?? 0) * player.marketValue, 0) / ageWeight
        : null;

    const byPosition = positionsPresent.map((position): PositionSlice => {
      const own = players.filter((player) => player.position === position);
      const ownStarterPoints = own
        .filter((player) => player.starting)
        .reduce((sum, player) => sum + player.points, 0);

      const across = leaguePositionPoints.get(position) ?? [];
      const best = Math.max(...across, 0);
      const worst = Math.min(...across, 0);

      return {
        position,
        starterPoints: ownStarterPoints,
        benchPoints: own.filter((p) => !p.starting).reduce((sum, player) => sum + player.points, 0),
        marketValue: own.reduce((sum, player) => sum + player.marketValue, 0),
        count: own.length,
        rank: across.filter((value) => value > ownStarterPoints).length + 1,
        strength: best > worst ? (ownStarterPoints - worst) / (best - worst) : 0.5,
      };
    });

    return {
      teamId: roster.teamId,
      name: teamNames.get(roster.teamId) ?? roster.teamId,
      isMine: roster.teamId === myTeamId,

      starterPoints,
      benchPoints: bench.reduce((sum, player) => sum + player.points, 0),
      totalPoints: players.reduce((sum, player) => sum + player.points, 0),
      marketValue: players.reduce((sum, player) => sum + player.marketValue, 0),
      starterMarketValue: starters.reduce((sum, player) => sum + player.marketValue, 0),

      playoffPct: outcome?.playoffPct ?? 0,
      titlePct: outcome?.titlePct ?? 0,
      expectedWins: outcome?.expectedWins ?? 0,
      rankDistribution: outcome?.rankDistribution ?? [],
      winDistribution: outcome?.winDistribution ?? [],

      wins: record?.wins ?? 0,
      losses: record?.losses ?? 0,
      ties: record?.ties ?? 0,
      pointsFor: record?.pointsFor ?? 0,
      pointsAgainst: record?.pointsAgainst ?? 0,

      weeklyScores: (scoresByTeam.get(roster.teamId) ?? [])
        .sort((a, b) => a.week - b.week)
        .map((entry) => entry.points),
      lineupEfficiency: efficiencies.get(roster.teamId)?.efficiency ?? 0,

      averageAge,
      rosterSize: players.length,
      topTwoShare: starterPoints > 0 ? topTwo / starterPoints : 0,

      byPosition,
    };
  });
};

/** Which positions any team in this league actually rosters, in reading order. */
export const positionsInPlay = (profiles: readonly TeamProfile[]): string[] =>
  profiles[0]?.byPosition.map((slice) => slice.position) ?? [];

/**
 * Contention window, from age and strength.
 *
 * Dynasty's only real question is *when* — a strong old roster and a strong
 * young one are opposite situations that look identical in the standings. Age
 * on one axis, current strength on the other, and the four quadrants are the
 * four honest answers.
 */
export const contentionQuadrant = (
  profile: TeamProfile,
  medianAge: number,
  medianStrength: number,
): string => {
  const strong = profile.starterPoints >= medianStrength;
  const old = (profile.averageAge ?? medianAge) >= medianAge;

  if (strong && !old) return 'Contending, young';
  if (strong && old) return 'Win now';
  if (!strong && !old) return 'Building';
  return 'Retool';
};
