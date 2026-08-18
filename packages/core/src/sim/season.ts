import type { LeagueSnapshot, PlayerId } from '../domain/index.js';
import { sampleWeek, type CorrelatedPlayer } from './correlated.js';
import { seededRng, type Rng } from './random.js';

/**
 * Season simulation.
 *
 * Plays the rest of the season many times and counts what happened. Everything
 * the product sells — playoff odds, title odds, leverage, the value of a trade —
 * is a difference between two runs of this.
 *
 * Deliberate choices, each one a place other tools take a shortcut:
 *
 * - Team scores come from *correlated player draws*, not a team-level normal.
 * - Managers are simulated at their own measured lineup efficiency, not as
 *   perfect optimizers, because nobody starts their optimal lineup.
 * - Guillotine leagues are simulated as elimination, not as head-to-head with
 *   the pairings ignored.
 * - The playoff bracket runs inside every iteration, so title odds inherit the
 *   full uncertainty of the regular season rather than being bolted on after.
 */

export interface TeamWeekProjection {
  readonly teamId: string;
  readonly week: number;
  readonly players: readonly CorrelatedPlayer[];
  /**
   * This manager's historical points-scored / optimal-points ratio. Applied as
   * a haircut, because simulating everyone as perfect systematically overrates
   * deep benches that never get started.
   */
  readonly lineupEfficiency: number;
}

export interface SeasonSimInput {
  readonly snapshot: LeagueSnapshot;
  readonly projections: readonly TeamWeekProjection[];
  readonly iterations?: number;
  readonly seed?: number;
  /**
   * Force a week's result to test "what if I win": maps matchupId to the team
   * that wins. Used for leverage and the rooting guide.
   */
  readonly forcedResults?: ReadonlyMap<string, string>;
}

export interface TeamOutcome {
  readonly teamId: string;
  readonly expectedWins: number;
  readonly playoffPct: number;
  readonly titlePct: number;
  readonly byePct: number;
  /** Distribution over final regular-season rank, index 0 = first. */
  readonly rankDistribution: readonly number[];
  /** Guillotine only: probability of surviving to each week. */
  readonly survivalByWeek: readonly number[];
}

export interface SeasonSimResult {
  readonly iterations: number;
  readonly teams: readonly TeamOutcome[];
}

interface MutableTally {
  wins: number;
  pointsFor: number;
  playoffs: number;
  titles: number;
  byes: number;
  rankCounts: number[];
  survivedThrough: number[];
}

const buildProjectionIndex = (
  projections: readonly TeamWeekProjection[],
): Map<number, Map<string, TeamWeekProjection>> => {
  const byWeek = new Map<number, Map<string, TeamWeekProjection>>();
  for (const projection of projections) {
    const week = byWeek.get(projection.week) ?? new Map<string, TeamWeekProjection>();
    week.set(projection.teamId, projection);
    byWeek.set(projection.week, week);
  }
  return byWeek;
};

/** Score one team for one week: sample its players, apply manager efficiency. */
const scoreTeam = (
  projection: TeamWeekProjection | undefined,
  sampled: Map<PlayerId, number>,
): number => {
  if (projection === undefined) return 0;

  let total = 0;
  for (const player of projection.players) {
    total += sampled.get(player.playerId) ?? 0;
  }
  return total * projection.lineupEfficiency;
};

export const simulateSeason = (input: SeasonSimInput): SeasonSimResult => {
  const { snapshot, projections } = input;
  const iterations = input.iterations ?? 10_000;
  const rng = seededRng(input.seed ?? 0x5eed);

  const teamIds = snapshot.rosters.map((r) => r.teamId);
  const teamCount = teamIds.length;
  const isGuillotine = snapshot.league.format === 'guillotine';

  const byWeek = buildProjectionIndex(projections);
  const remainingWeeks = [...byWeek.keys()].filter((w) => w >= snapshot.asOfWeek).sort((a, b) => a - b);

  const playoffTeams = Math.max(1, Math.min(snapshot.league.playoffTeams, teamCount));

  const tallies = new Map<string, MutableTally>(
    teamIds.map((id) => [
      id,
      {
        wins: 0,
        pointsFor: 0,
        playoffs: 0,
        titles: 0,
        byes: 0,
        rankCounts: Array(teamCount).fill(0),
        survivedThrough: Array(snapshot.league.regularSeasonWeeks + 1).fill(0),
      },
    ]),
  );

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const record = new Map<string, { wins: number; points: number }>(
      teamIds.map((id) => {
        const existing = snapshot.records.find((r) => r.teamId === id);
        return [
          id,
          { wins: (existing?.wins ?? 0) + 0.5 * (existing?.ties ?? 0), points: existing?.pointsFor ?? 0 },
        ];
      }),
    );

    // Guillotine: everyone starts alive and the lowest scorer is chopped weekly.
    const alive = new Set(teamIds);

    for (const week of remainingWeeks) {
      const weekProjections = byWeek.get(week);
      if (weekProjections === undefined) continue;

      const allPlayers = [...weekProjections.values()]
        .filter((p) => !isGuillotine || alive.has(p.teamId))
        .flatMap((p) => p.players);
      const sampled = sampleWeek(allPlayers, rng);

      const scores = new Map<string, number>();
      for (const teamId of teamIds) {
        if (isGuillotine && !alive.has(teamId)) continue;
        scores.set(teamId, scoreTeam(weekProjections.get(teamId), sampled));
      }

      for (const [teamId, points] of scores) {
        record.get(teamId)!.points += points;
      }

      if (isGuillotine) {
        for (const teamId of alive) {
          const survived = tallies.get(teamId)!.survivedThrough;
          survived[week] = (survived[week] ?? 0) + 1;
        }
        chopLowest(scores, alive);
        continue;
      }

      settleMatchups(snapshot, week, scores, record, input.forcedResults, rng);
    }

    recordFinish(snapshot, teamIds, record, tallies, playoffTeams, isGuillotine, alive, rng);
  }

  return {
    iterations,
    teams: teamIds.map((teamId) => {
      const tally = tallies.get(teamId)!;
      return {
        teamId,
        expectedWins: tally.wins / iterations,
        playoffPct: tally.playoffs / iterations,
        titlePct: tally.titles / iterations,
        byePct: tally.byes / iterations,
        rankDistribution: tally.rankCounts.map((c) => c / iterations),
        survivalByWeek: tally.survivedThrough.map((c) => c / iterations),
      };
    }),
  };
};

/** Lowest scorer is eliminated; their roster returns to the free agent pool. */
const chopLowest = (scores: Map<string, number>, alive: Set<string>): void => {
  let lowestTeam: string | null = null;
  let lowestScore = Number.POSITIVE_INFINITY;

  for (const [teamId, points] of scores) {
    if (points < lowestScore) {
      lowestScore = points;
      lowestTeam = teamId;
    }
  }
  if (lowestTeam !== null) alive.delete(lowestTeam);
};

const settleMatchups = (
  snapshot: LeagueSnapshot,
  week: number,
  scores: Map<string, number>,
  record: Map<string, { wins: number; points: number }>,
  forcedResults: ReadonlyMap<string, string> | undefined,
  rng: Rng,
): void => {
  const matchups = snapshot.schedule.filter((m) => m.week === week);

  for (const matchup of matchups) {
    const [a, b] = matchup.teamIds;
    const forced = forcedResults?.get(matchup.matchupId);

    if (forced !== undefined) {
      record.get(forced)!.wins += 1;
      continue;
    }

    const scoreA = scores.get(a) ?? 0;
    const scoreB = scores.get(b) ?? 0;

    if (scoreA > scoreB) record.get(a)!.wins += 1;
    else if (scoreB > scoreA) record.get(b)!.wins += 1;
    else {
      // Exact ties are vanishingly rare with decimal scoring, but they exist.
      record.get(a)!.wins += 0.5;
      record.get(b)!.wins += 0.5;
    }
  }

  // Median-win leagues award a second win for beating the weekly median.
  if (snapshot.league.medianWins && scores.size > 0) {
    const sorted = [...scores.values()].sort((x, y) => x - y);
    const mid = sorted.length >> 1;
    const median =
      sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;

    for (const [teamId, points] of scores) {
      if (points > median) record.get(teamId)!.wins += 1;
      else if (points === median) record.get(teamId)!.wins += 0.5;
    }
  }

  void rng;
};

const recordFinish = (
  snapshot: LeagueSnapshot,
  teamIds: readonly string[],
  record: Map<string, { wins: number; points: number }>,
  tallies: Map<string, MutableTally>,
  playoffTeams: number,
  isGuillotine: boolean,
  alive: Set<string>,
  rng: Rng,
): void => {
  if (isGuillotine) {
    // The survivor wins; there is no bracket.
    const winner = [...alive][0];
    if (winner !== undefined) tallies.get(winner)!.titles += 1;
    for (const teamId of teamIds) {
      tallies.get(teamId)!.wins += record.get(teamId)!.points / 100;
    }
    return;
  }

  // Standings: wins first, total points as the tiebreaker — the near-universal
  // fantasy convention.
  const standings = [...teamIds].sort((a, b) => {
    const recordA = record.get(a)!;
    const recordB = record.get(b)!;
    return recordB.wins - recordA.wins || recordB.points - recordA.points;
  });

  standings.forEach((teamId, index) => {
    const tally = tallies.get(teamId)!;
    tally.wins += record.get(teamId)!.wins;
    tally.rankCounts[index] = (tally.rankCounts[index] ?? 0) + 1;
    if (index < playoffTeams) tally.playoffs += 1;
  });

  const bracket = standings.slice(0, playoffTeams);

  // A bye exists whenever the field isn't a power of two: the top seeds sit out
  // round one.
  const byes = nextPowerOfTwo(playoffTeams) - playoffTeams;
  for (let i = 0; i < byes; i += 1) {
    const teamId = bracket[i];
    if (teamId !== undefined) tallies.get(teamId)!.byes += 1;
  }

  const champion = simulateBracket(bracket, record, rng);
  if (champion !== null) tallies.get(champion)!.titles += 1;
};

const nextPowerOfTwo = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * Seeded single-elimination bracket.
 *
 * Rather than re-sampling full lineups for playoff weeks — which would cost
 * more than it buys — each game is decided by a draw around the teams' realized
 * scoring rate, preserving both seeding advantage and genuine upset risk.
 */
const simulateBracket = (
  seeds: readonly string[],
  record: Map<string, { wins: number; points: number }>,
  rng: Rng,
): string | null => {
  if (seeds.length === 0) return null;

  let field = [...seeds];

  while (field.length > 1) {
    const next: string[] = [];
    const byes = nextPowerOfTwo(field.length) - field.length;

    for (let i = 0; i < byes; i += 1) {
      const team = field[i];
      if (team !== undefined) next.push(team);
    }

    for (let i = byes; i < field.length; i += 1) {
      const home = field[i];
      const away = field[field.length - 1 - (i - byes)];
      if (home === undefined || away === undefined) continue;
      if (next.includes(home) || next.includes(away)) continue;
      if (home === away) {
        next.push(home);
        continue;
      }

      const strengthHome = record.get(home)?.points ?? 1;
      const strengthAway = record.get(away)?.points ?? 1;
      const total = strengthHome + strengthAway;
      const probabilityHome = total > 0 ? strengthHome / total : 0.5;

      // Damp toward a coin flip: single fantasy games are far closer to even
      // than season-long scoring totals imply.
      const damped = 0.5 + (probabilityHome - 0.5) * 0.6;
      next.push(rng() < damped ? home : away);
    }

    field = next;
  }

  return field[0] ?? null;
};
