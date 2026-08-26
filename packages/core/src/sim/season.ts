import type { LeagueSnapshot, Matchup } from '../domain/index.js';
import { sampleWeek, sampleWeekInto, type CorrelatedPlayer } from './correlated.js';
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
 *
 * This is the hot path of the whole product — a page load is one call, and a
 * what-if is two — so everything that does not vary between iterations is
 * indexed once up front and the inner loop works on typed arrays keyed by team
 * and player index rather than on maps keyed by string.
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

/**
 * Ask for this week's games to be priced while the season is being simulated.
 *
 * Answering "how much is this game worth to me" by re-simulating the season
 * once per possible result costs one full simulation per game per side — the
 * single most expensive thing the app used to do. It is also noisier than it
 * needs to be, because each re-run draws its own random seasons.
 *
 * Forcing a result only changes who is credited with a win; nobody's *scores*
 * change. So the same simulated seasons can answer every version of the
 * question at once: re-credit the game inside each iteration, re-rank, and
 * count. One simulation, every game priced, and the comparison is made against
 * identical seasons rather than independent ones — which removes the sampling
 * noise that otherwise swamps a two-point swing.
 */
export interface LeverageRequest {
  /** Whose playoff odds the games are priced against. */
  readonly teamId: string;
  readonly week: number;
}

export interface MatchupLeverage {
  readonly matchupId: string;
  readonly week: number;
  readonly teamIds: readonly [string, string];
  /**
   * The requested team's playoff probability when each side of this game is
   * forced to win — indexed to match `teamIds`.
   */
  readonly playoffPctIfWins: readonly [number, number];
}

export interface SeasonSimInput {
  readonly snapshot: LeagueSnapshot;
  readonly projections: readonly TeamWeekProjection[];
  readonly iterations?: number;
  readonly seed?: number;
  /**
   * Force a week's result to test "what if I win": maps matchupId to the team
   * that wins. Used for one-off counterfactuals; to price a whole week, prefer
   * `leverage`, which answers the same question in a single run.
   */
  readonly forcedResults?: ReadonlyMap<string, string>;
  /** Price every game in one week against one team's playoff odds. */
  readonly leverage?: LeverageRequest;
}

export interface TeamOutcome {
  readonly teamId: string;
  readonly expectedWins: number;
  readonly playoffPct: number;
  readonly titlePct: number;
  readonly byePct: number;
  /** Distribution over final regular-season rank, index 0 = first. */
  readonly rankDistribution: readonly number[];
  /**
   * Distribution over final win totals, index = wins.
   *
   * The spread here is what a single "projected wins" number hides: two teams
   * with the same average can have very different seasons available to them.
   */
  readonly winDistribution: readonly number[];
  /** Guillotine only: probability of surviving to each week. */
  readonly survivalByWeek: readonly number[];
}

export interface SeasonSimResult {
  readonly iterations: number;
  readonly teams: readonly TeamOutcome[];
  /** Present only when `leverage` was requested and the league plays matchups. */
  readonly leverage?: readonly MatchupLeverage[];
}

interface MutableTally {
  wins: number;
  playoffs: number;
  titles: number;
  byes: number;
  rankCounts: number[];
  winCounts: number[];
  survivedThrough: number[];
}

/**
 * One week, arranged for the inner loop.
 *
 * `entries` preserves the order the projections arrived in, because that order
 * decides the order random draws are consumed and therefore what a given seed
 * produces. `players` is every entry's players concatenated once, so the common
 * case samples a flat array instead of rebuilding one per iteration.
 */
interface WeekPlan {
  readonly week: number;
  readonly entries: readonly {
    readonly teamIndex: number;
    readonly players: readonly CorrelatedPlayer[];
    readonly efficiency: number;
    /** Where this entry's players sit in `players`. */
    readonly start: number;
    readonly end: number;
  }[];
  readonly players: readonly CorrelatedPlayer[];
  readonly matchups: readonly Matchup[];
}

const buildWeekPlans = (
  projections: readonly TeamWeekProjection[],
  teamIndexOf: ReadonlyMap<string, number>,
  scheduleByWeek: ReadonlyMap<number, readonly Matchup[]>,
  fromWeek: number,
): WeekPlan[] => {
  const byWeek = new Map<number, TeamWeekProjection[]>();
  for (const projection of projections) {
    const bucket = byWeek.get(projection.week);
    if (bucket === undefined) byWeek.set(projection.week, [projection]);
    else bucket.push(projection);
  }

  return [...byWeek.keys()]
    .filter((week) => week >= fromWeek)
    .sort((a, b) => a - b)
    .map((week) => {
      const players: CorrelatedPlayer[] = [];
      const entries = (byWeek.get(week) ?? []).flatMap((projection) => {
        const teamIndex = teamIndexOf.get(projection.teamId);
        if (teamIndex === undefined) return [];

        const start = players.length;
        players.push(...projection.players);

        return [
          {
            teamIndex,
            players: projection.players,
            efficiency: projection.lineupEfficiency,
            start,
            end: players.length,
          },
        ];
      });

      return { week, entries, players, matchups: scheduleByWeek.get(week) ?? [] };
    });
};

export const simulateSeason = (input: SeasonSimInput): SeasonSimResult => {
  const { snapshot, projections } = input;
  const iterations = input.iterations ?? 10_000;
  const rng = seededRng(input.seed ?? 0x5eed);

  const teamIds = snapshot.rosters.map((r) => r.teamId);
  const teamCount = teamIds.length;
  const teamIndexOf = new Map(teamIds.map((id, index) => [id, index]));
  const isGuillotine = snapshot.league.format === 'guillotine';

  const scheduleByWeek = new Map<number, Matchup[]>();
  for (const matchup of snapshot.schedule) {
    const bucket = scheduleByWeek.get(matchup.week);
    if (bucket === undefined) scheduleByWeek.set(matchup.week, [matchup]);
    else bucket.push(matchup);
  }

  const weekPlans = buildWeekPlans(projections, teamIndexOf, scheduleByWeek, snapshot.asOfWeek);

  const playoffTeams = Math.max(1, Math.min(snapshot.league.playoffTeams, teamCount));

  // Wins and points carried in from games already played.
  const startingWins = new Float64Array(teamCount);
  const startingPoints = new Float64Array(teamCount);
  for (const record of snapshot.records) {
    const index = teamIndexOf.get(record.teamId);
    if (index === undefined) continue;
    startingWins[index] = record.wins + 0.5 * record.ties;
    startingPoints[index] = record.pointsFor;
  }

  const tallies = teamIds.map(
    (): MutableTally => ({
      wins: 0,
      playoffs: 0,
      titles: 0,
      byes: 0,
      rankCounts: Array(teamCount).fill(0),
      // Median-win leagues award up to two wins a week, so the ceiling is
      // twice the schedule rather than once.
      winCounts: Array(snapshot.league.regularSeasonWeeks * (snapshot.league.medianWins ? 2 : 1) + 1).fill(0),
      survivedThrough: Array(snapshot.league.regularSeasonWeeks + 1).fill(0),
    }),
  );

  const wins = new Float64Array(teamCount);
  const points = new Float64Array(teamCount);
  const scores = new Float64Array(teamCount);
  const scored = new Uint8Array(teamCount);
  const ranked: number[] = teamIds.map((_, index) => index);

  const maxPlayers = weekPlans.reduce((most, plan) => Math.max(most, plan.players.length), 0);
  const sampled = new Float64Array(maxPlayers);
  const playoffScores = weekPlans
    .filter((plan) => plan.week > snapshot.league.regularSeasonWeeks)
    .map((plan) => ({ week: plan.week, scores: new Float64Array(teamCount) }));
  const playoffScoreByWeek = new Map(playoffScores.map((entry) => [entry.week, entry.scores]));

  // Only a week that is actually being simulated can be priced.
  const leverage =
    isGuillotine || !weekPlans.some((plan) => plan.week === input.leverage?.week)
      ? undefined
      : prepareLeverage(input.leverage, scheduleByWeek, teamIndexOf);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    wins.set(startingWins);
    points.set(startingPoints);

    // Guillotine: everyone starts alive and the lowest scorer is chopped weekly.
    const alive = isGuillotine ? new Set(teamIds) : null;

    for (const plan of weekPlans) {
      scored.fill(0);

      if (alive === null) {
        sampleWeekInto(plan.players, rng, sampled);

        for (const entry of plan.entries) {
          let total = 0;
          for (let i = entry.start; i < entry.end; i += 1) total += sampled[i]!;
          scores[entry.teamIndex] = total * entry.efficiency;
          scored[entry.teamIndex] = 1;
        }
      } else {
        // The field shrinks every week, so a dead team's players must not be
        // drawn at all — the surviving draws would shift with them.
        const live = plan.entries.filter((entry) => alive.has(teamIds[entry.teamIndex]!));
        const drawn = sampleWeek(live.flatMap((entry) => entry.players), rng);

        for (const entry of live) {
          let total = 0;
          for (const player of entry.players) total += drawn.get(player.playerId) ?? 0;
          scores[entry.teamIndex] = total * entry.efficiency;
          scored[entry.teamIndex] = 1;
        }
      }

      if (alive === null && plan.week > snapshot.league.regularSeasonWeeks) {
        for (let team = 0; team < teamCount; team += 1) {
          if (scored[team] === 0) scores[team] = 0;
        }
        playoffScoreByWeek.get(plan.week)?.set(scores);
        continue;
      }

      for (let team = 0; team < teamCount; team += 1) {
        if (alive !== null && !alive.has(teamIds[team]!)) continue;
        if (scored[team] === 0) scores[team] = 0;
        points[team]! += scores[team]!;
      }

      if (alive !== null) {
        for (const teamId of alive) {
          const survived = tallies[teamIndexOf.get(teamId)!]!.survivedThrough;
          survived[plan.week] = (survived[plan.week] ?? 0) + 1;
        }
        chopLowest(scores, alive, teamIds, teamIndexOf, rng);
        continue;
      }

      settleMatchups(snapshot, plan, scores, wins, teamIndexOf, input.forcedResults, leverage);
    }

    if (leverage !== undefined) {
      recordLeverage(leverage, wins, points, teamCount, playoffTeams);
    }

    recordFinish(
      teamIds, teamIndexOf, wins, points, ranked, tallies, playoffTeams,
      isGuillotine, alive, rng, playoffScores.map((entry) => entry.scores),
    );
  }

  return {
    iterations,
    teams: teamIds.map((teamId, index) => {
      const tally = tallies[index]!;
      return {
        teamId,
        expectedWins: tally.wins / iterations,
        playoffPct: tally.playoffs / iterations,
        titlePct: tally.titles / iterations,
        byePct: tally.byes / iterations,
        rankDistribution: tally.rankCounts.map((c) => c / iterations),
        winDistribution: tally.winCounts.map((c) => c / iterations),
        survivalByWeek: tally.survivedThrough.map((c) => c / iterations),
      };
    }),
    ...(leverage === undefined
      ? {}
      : {
          leverage: leverage.matchups.map((matchup, index) => ({
            matchupId: matchup.matchupId,
            week: matchup.week,
            teamIds: [teamIds[matchup.a]!, teamIds[matchup.b]!] as const,
            playoffPctIfWins: [
              leverage.playoffsIfA[index]! / iterations,
              leverage.playoffsIfB[index]! / iterations,
            ] as const,
          })),
        }),
  };
};

/**
 * Lowest scorer is eliminated; their roster returns to the free agent pool.
 *
 * Ties are broken at random rather than by iteration order. It sounds pedantic,
 * but before a draft every team scores exactly zero — and a first-encountered
 * tiebreak then hands the same team a 100% survival rate in every iteration,
 * which is a confidently wrong answer rather than an honest "we don't know yet".
 */
const chopLowest = (
  scores: Float64Array,
  alive: Set<string>,
  teamIds: readonly string[],
  teamIndexOf: ReadonlyMap<string, number>,
  rng: Rng,
): void => {
  let lowestScore = Number.POSITIVE_INFINITY;
  let tied: string[] = [];

  for (const teamId of alive) {
    const value = scores[teamIndexOf.get(teamId)!]!;
    if (value < lowestScore) {
      lowestScore = value;
      tied = [teamId];
    } else if (value === lowestScore) {
      tied.push(teamId);
    }
  }

  const chopped = tied[Math.floor(rng() * tied.length)];
  if (chopped !== undefined) alive.delete(chopped);
  void teamIds;
};

/** Per-iteration bookkeeping for pricing one week's games. See `LeverageRequest`. */
interface LeverageState {
  readonly teamIndex: number;
  readonly week: number;
  readonly matchups: readonly { matchupId: string; week: number; a: number; b: number }[];
  /** Win credit each side actually earned this iteration, before re-crediting. */
  readonly creditA: Float64Array;
  readonly creditB: Float64Array;
  readonly playoffsIfA: Float64Array;
  readonly playoffsIfB: Float64Array;
}

const prepareLeverage = (
  request: LeverageRequest | undefined,
  scheduleByWeek: ReadonlyMap<number, readonly Matchup[]>,
  teamIndexOf: ReadonlyMap<string, number>,
): LeverageState | undefined => {
  if (request === undefined) return undefined;

  const teamIndex = teamIndexOf.get(request.teamId);
  if (teamIndex === undefined) return undefined;

  const matchups = (scheduleByWeek.get(request.week) ?? []).flatMap((matchup) => {
    const a = teamIndexOf.get(matchup.teamIds[0]);
    const b = teamIndexOf.get(matchup.teamIds[1]);
    if (a === undefined || b === undefined) return [];
    return [{ matchupId: matchup.matchupId, week: matchup.week, a, b }];
  });

  if (matchups.length === 0) return undefined;

  return {
    teamIndex,
    week: request.week,
    matchups,
    creditA: new Float64Array(matchups.length),
    creditB: new Float64Array(matchups.length),
    playoffsIfA: new Float64Array(matchups.length),
    playoffsIfB: new Float64Array(matchups.length),
  };
};

/**
 * Replay one week's games with each result forced, against the season that was
 * just simulated.
 *
 * Only the two teams in a game move, so their standing is recomputed rather
 * than the whole table re-sorted. Rank is "how many teams finished strictly
 * ahead" on wins then points, which is the same ordering `recordFinish` sorts
 * by; exact ties on both are possible only before a draft, when nothing here
 * is meaningful anyway.
 */
const recordLeverage = (
  state: LeverageState,
  wins: Float64Array,
  points: Float64Array,
  teamCount: number,
  playoffTeams: number,
): void => {
  const me = state.teamIndex;

  const isAhead = (team: number, teamWins: number, myWins: number): boolean =>
    team !== me && (teamWins > myWins || (teamWins === myWins && points[team]! > points[me]!));

  let baseAhead = 0;
  for (let team = 0; team < teamCount; team += 1) {
    if (isAhead(team, wins[team]!, wins[me]!)) baseAhead += 1;
  }

  for (let index = 0; index < state.matchups.length; index += 1) {
    const { a, b } = state.matchups[index]!;
    const creditA = state.creditA[index]!;
    const creditB = state.creditB[index]!;

    const madePlayoffs = (winner: number, loser: number): boolean => {
      const winnerWins = wins[winner]! + 1 - (winner === a ? creditA : creditB);
      const loserWins = wins[loser]! - (loser === a ? creditA : creditB);

      // My own win total moved, so every comparison has to be redone.
      if (winner === me || loser === me) {
        const myWins = winner === me ? winnerWins : loserWins;
        let ahead = 0;
        for (let team = 0; team < teamCount; team += 1) {
          const teamWins =
            team === winner ? winnerWins : team === loser ? loserWins : wins[team]!;
          if (isAhead(team, teamWins, myWins)) ahead += 1;
        }
        return ahead < playoffTeams;
      }

      let ahead = baseAhead;
      const myWins = wins[me]!;
      ahead += Number(isAhead(winner, winnerWins, myWins)) - Number(isAhead(winner, wins[winner]!, myWins));
      ahead += Number(isAhead(loser, loserWins, myWins)) - Number(isAhead(loser, wins[loser]!, myWins));
      return ahead < playoffTeams;
    };

    if (madePlayoffs(a, b)) state.playoffsIfA[index]! += 1;
    if (madePlayoffs(b, a)) state.playoffsIfB[index]! += 1;
  }
};

const settleMatchups = (
  snapshot: LeagueSnapshot,
  plan: WeekPlan,
  scores: Float64Array,
  wins: Float64Array,
  teamIndexOf: ReadonlyMap<string, number>,
  forcedResults: ReadonlyMap<string, string> | undefined,
  leverage: LeverageState | undefined,
): void => {
  const capture = leverage !== undefined && leverage.week === plan.week;

  for (let index = 0; index < plan.matchups.length; index += 1) {
    const matchup = plan.matchups[index]!;
    const a = teamIndexOf.get(matchup.teamIds[0]);
    const b = teamIndexOf.get(matchup.teamIds[1]);
    if (a === undefined || b === undefined) continue;

    const forced = forcedResults?.get(matchup.matchupId);
    if (forced !== undefined) {
      const winner = teamIndexOf.get(forced);
      if (winner !== undefined) wins[winner]! += 1;
      if (capture) {
        leverage.creditA[index] = winner === a ? 1 : 0;
        leverage.creditB[index] = winner === b ? 1 : 0;
      }
      continue;
    }

    const scoreA = scores[a]!;
    const scoreB = scores[b]!;

    // Exact ties are vanishingly rare with decimal scoring, but they exist.
    const creditA = scoreA > scoreB ? 1 : scoreA === scoreB ? 0.5 : 0;
    const creditB = 1 - creditA;

    wins[a]! += creditA;
    wins[b]! += creditB;

    if (capture) {
      leverage.creditA[index] = creditA;
      leverage.creditB[index] = creditB;
    }
  }

  // Median-win leagues award a second win for beating the weekly median. It is
  // decided by scores, so forcing a head-to-head result never changes it — and
  // that is why leverage only has to re-credit the game itself.
  if (snapshot.league.medianWins && scores.length > 0) {
    const values = Array.from(scores).sort((x, y) => x - y);
    const mid = values.length >> 1;
    const median = values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;

    for (let team = 0; team < scores.length; team += 1) {
      const value = scores[team]!;
      if (value > median) wins[team]! += 1;
      else if (value === median) wins[team]! += 0.5;
    }
  }
};

const recordFinish = (
  teamIds: readonly string[],
  teamIndexOf: ReadonlyMap<string, number>,
  wins: Float64Array,
  points: Float64Array,
  ranked: number[],
  tallies: readonly MutableTally[],
  playoffTeams: number,
  isGuillotine: boolean,
  alive: Set<string> | null,
  rng: Rng,
  playoffScores: readonly Float64Array[],
): void => {
  if (isGuillotine) {
    // The survivor wins; there is no bracket.
    const winner = alive === null ? undefined : [...alive][0];
    if (winner !== undefined) tallies[teamIndexOf.get(winner)!]!.titles += 1;
    for (let team = 0; team < teamIds.length; team += 1) {
      tallies[team]!.wins += points[team]! / 100;
    }
    return;
  }

  // Standings: wins first, total points as the tiebreaker — the near-universal
  // fantasy convention. Sorted from team order every iteration, so a tie on
  // both falls back to the same order the snapshot listed rosters in.
  for (let team = 0; team < teamIds.length; team += 1) ranked[team] = team;
  ranked.sort((a, b) => wins[b]! - wins[a]! || points[b]! - points[a]!);

  ranked.forEach((team, index) => {
    const tally = tallies[team]!;
    const finalWins = wins[team]!;

    tally.wins += finalWins;
    tally.rankCounts[index] = (tally.rankCounts[index] ?? 0) + 1;

    // Half-wins from ties round to the nearest whole for the histogram; the
    // expected-wins figure keeps the exact value.
    const bucket = Math.min(tally.winCounts.length - 1, Math.max(0, Math.round(finalWins)));
    tally.winCounts[bucket] = (tally.winCounts[bucket] ?? 0) + 1;

    if (index < playoffTeams) tally.playoffs += 1;
  });

  const bracket = ranked.slice(0, playoffTeams);

  // A bye exists whenever the field isn't a power of two: the top seeds sit out
  // round one.
  const byes = nextPowerOfTwo(playoffTeams) - playoffTeams;
  for (let i = 0; i < byes; i += 1) {
    const team = bracket[i];
    if (team !== undefined) tallies[team]!.byes += 1;
  }

  const champion = simulateBracket(bracket, points, rng, playoffScores);
  if (champion !== null) tallies[champion]!.titles += 1;
};

const nextPowerOfTwo = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * Seeded single-elimination bracket.
 *
 * Uses the lineup and joint stat-line draw for the actual playoff week. The
 * season-strength fallback exists only for old callers that do not provide
 * playoff projections.
 */
const simulateBracket = (
  seeds: readonly number[],
  points: Float64Array,
  rng: Rng,
  playoffScores: readonly Float64Array[],
): number | null => {
  if (seeds.length === 0) return null;

  let field = [...seeds];

  let round = 0;
  while (field.length > 1) {
    const next: number[] = [];
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

      const weekly = playoffScores[round];
      if (weekly !== undefined) {
        const homeScore = weekly[home] ?? 0;
        const awayScore = weekly[away] ?? 0;
        next.push(homeScore === awayScore ? (rng() < 0.5 ? home : away) : homeScore > awayScore ? home : away);
      } else {
        const strengthHome = points[home] ?? 1;
        const strengthAway = points[away] ?? 1;
        const total = strengthHome + strengthAway;
        const probabilityHome = total > 0 ? strengthHome / total : 0.5;
        const damped = 0.5 + (probabilityHome - 0.5) * 0.6;
        next.push(rng() < damped ? home : away);
      }
    }

    field = next;
    round += 1;
  }

  return field[0] ?? null;
};
