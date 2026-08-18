import type { LeagueSnapshot } from '../domain/index.js';

/**
 * Schedule luck.
 *
 * A fantasy record is two things braided together: how much you scored, and who
 * you happened to play. Standings show the braid and nothing else, which is why
 * every league has an argument about the 6-4 team that has been outscored by the
 * 4-6 team.
 *
 * We separate them two ways, because they answer different questions:
 *
 * - **All-play** — each week, your score against all eleven others. This is the
 *   schedule-free measure of how well you have actually played, and it is what
 *   `expectedWins` reports.
 * - **Schedule swap** — replay your exact scores through every other team's
 *   schedule. This answers the specific complaint ("I'd be 8-2 with his games"),
 *   and the spread between the best and worst of those records is the honest
 *   size of the luck in this league so far.
 *
 * Both use only weeks that have actually been played. Neither is a projection.
 */

export interface ScheduleLuck {
  readonly teamId: string;
  /** Wins actually banked, counting a tie as half. */
  readonly actualWins: number;
  /**
   * Wins this team would average against a random opponent each week — its
   * all-play winning percentage scaled to games played.
   */
  readonly expectedWins: number;
  /** actualWins − expectedWins. Positive means the schedule has been kind. */
  readonly luck: number;
  /** Wins under the friendliest and harshest schedule in the league. */
  readonly bestScheduleWins: number;
  readonly worstScheduleWins: number;
  /** Wins under each team's schedule, keyed by that team's id. */
  readonly winsBySchedule: ReadonlyMap<string, number>;
  readonly weeksPlayed: number;
}

interface WeekScores {
  readonly week: number;
  /** teamId -> points, for teams that actually played that week. */
  readonly points: ReadonlyMap<string, number>;
}

/** Played weeks only, as a score table per week. */
const playedWeeks = (snapshot: LeagueSnapshot): WeekScores[] => {
  const byWeek = new Map<number, Map<string, number>>();

  for (const score of snapshot.weeklyScores) {
    if (!score.played) continue;
    const week = byWeek.get(score.week) ?? new Map<string, number>();
    week.set(score.teamId, score.points);
    byWeek.set(score.week, week);
  }

  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, points]) => ({ week, points }));
};

/** week -> teamId -> opponent teamId, from the real schedule. */
const opponentIndex = (snapshot: LeagueSnapshot): Map<number, Map<string, string>> => {
  const byWeek = new Map<number, Map<string, string>>();

  for (const matchup of snapshot.schedule) {
    const [a, b] = matchup.teamIds;
    const week = byWeek.get(matchup.week) ?? new Map<string, string>();
    week.set(a, b);
    week.set(b, a);
    byWeek.set(matchup.week, week);
  }

  return byWeek;
};

const outcome = (mine: number, theirs: number): number =>
  mine > theirs ? 1 : mine === theirs ? 0.5 : 0;

/**
 * The weekly median, for leagues that award a second win for beating it.
 *
 * Median wins are schedule-independent by construction — they are the same under
 * every schedule — so they are added to every alternate record identically. That
 * matters: leaving them out would make the swapped records incomparable to the
 * real one in exactly the leagues that use them.
 */
const medianOf = (points: readonly number[]): number => {
  const sorted = [...points].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export const scheduleLuck = (snapshot: LeagueSnapshot): Map<string, ScheduleLuck> => {
  const teamIds = snapshot.rosters.map((r) => r.teamId);
  const weeks = playedWeeks(snapshot);
  const opponents = opponentIndex(snapshot);
  const useMedian = snapshot.league.medianWins;

  const out = new Map<string, ScheduleLuck>();

  for (const teamId of teamIds) {
    const record = snapshot.records.find((r) => r.teamId === teamId);
    const actualWins = (record?.wins ?? 0) + 0.5 * (record?.ties ?? 0);

    let allPlayWon = 0;
    let allPlayGames = 0;
    let weeksPlayed = 0;
    let medianWins = 0;

    // Wins accumulated under each other team's schedule.
    const winsBySchedule = new Map<string, number>(teamIds.map((id) => [id, 0]));

    for (const { week, points } of weeks) {
      const mine = points.get(teamId);
      if (mine === undefined) continue;
      weeksPlayed += 1;

      for (const [otherId, theirs] of points) {
        if (otherId === teamId) continue;
        allPlayWon += outcome(mine, theirs);
        allPlayGames += 1;
      }

      if (useMedian && points.size > 0) {
        const median = medianOf([...points.values()]);
        medianWins += mine > median ? 1 : mine === median ? 0.5 : 0;
      }

      const weekOpponents = opponents.get(week);
      if (weekOpponents === undefined) continue;

      for (const scheduleOwner of teamIds) {
        // Whose opponent would I have faced in this week, had I owned this
        // team's schedule? If that schedule says they played me, then under the
        // swap I play them — otherwise I'd be playing myself.
        const raw = weekOpponents.get(scheduleOwner);
        const opponentId = raw === teamId ? scheduleOwner : raw;
        if (opponentId === undefined || opponentId === teamId) continue;

        const theirs = points.get(opponentId);
        if (theirs === undefined) continue;

        winsBySchedule.set(scheduleOwner, winsBySchedule.get(scheduleOwner)! + outcome(mine, theirs));
      }
    }

    // Median wins ride along with every schedule, including the real one.
    if (useMedian) {
      for (const scheduleOwner of teamIds) {
        winsBySchedule.set(scheduleOwner, winsBySchedule.get(scheduleOwner)! + medianWins);
      }
    }

    const swapped = [...winsBySchedule.values()];
    const expectedWins =
      allPlayGames > 0 ? (allPlayWon / allPlayGames) * weeksPlayed + medianWins : 0;

    out.set(teamId, {
      teamId,
      actualWins,
      expectedWins,
      luck: actualWins - expectedWins,
      bestScheduleWins: swapped.length > 0 ? Math.max(...swapped) : 0,
      worstScheduleWins: swapped.length > 0 ? Math.min(...swapped) : 0,
      winsBySchedule,
      weeksPlayed,
    });
  }

  return out;
};
