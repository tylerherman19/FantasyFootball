/**
 * Three-way power rankings.
 *
 * Ranking teams one way hides the interesting part. A roster can be the most
 * valuable collection of players in the league and still be the fifth-likeliest
 * champion, and *that gap is the information* — it means the value is in the
 * wrong shape (all of it on the bench, or concentrated at a position that starts
 * one player), or the schedule is brutal, or both.
 *
 * So every team is ranked three separate ways and the divergences are reported
 * rather than averaged away into a single composite number. Composite rankings
 * are popular because they are easy to read and they destroy exactly the signal
 * you would act on.
 *
 * - **Market value** — what the roster would fetch. Answers "could I trade for
 *   anyone I want", and is the only one of the three that is not our opinion.
 * - **Projected wins** — how the regular season should go.
 * - **Title odds** — the only one that is the actual objective, and the one most
 *   distorted by playoff seeding and variance.
 */

export interface RankingInput {
  readonly teamId: string;
  /** Summed market value of the roster. Same units for every team. */
  readonly marketValue: number;
  readonly expectedWins: number;
  readonly titlePct: number;
  readonly playoffPct: number;
}

/**
 * What a team's divergence means, stated plainly.
 *
 * `stranded` — the roster is worth more than the season it is producing.
 * `overachieving` — the odds are better than the roster, so they depend on
 * things that can stop being true.
 */
export type RankingSignal = 'stranded' | 'overachieving' | 'aligned';

export interface TeamRanking {
  readonly teamId: string;
  readonly marketValue: number;
  readonly expectedWins: number;
  readonly titlePct: number;
  readonly playoffPct: number;
  /** 1 = best in the league on that measure. */
  readonly valueRank: number;
  readonly winsRank: number;
  readonly titleRank: number;
  /**
   * valueRank − titleRank. Positive means the title odds rank better than the
   * roster does; negative means the roster is being wasted.
   */
  readonly divergence: number;
  readonly signal: RankingSignal;
}

/** Dense ranks, 1-based, ties sharing a rank. Higher input value ranks better. */
const rankBy = <T>(items: readonly T[], value: (item: T) => number): Map<T, number> => {
  const sorted = [...items].sort((a, b) => value(b) - value(a));
  const ranks = new Map<T, number>();

  sorted.forEach((item, index) => {
    const previous = sorted[index - 1];
    // Equal values share a rank, so a two-way tie for first is not silently
    // reported as first and second.
    if (previous !== undefined && value(previous) === value(item)) {
      ranks.set(item, ranks.get(previous)!);
      return;
    }
    ranks.set(item, index + 1);
  });

  return ranks;
};

/**
 * How far apart two ranks must be before it is worth saying anything.
 *
 * Scaled to league size: two places apart in a 10-team league is noise, and in a
 * 30-team dynasty startup it is nothing at all.
 */
const divergenceThreshold = (teamCount: number): number => Math.max(2, Math.round(teamCount / 4));

export const powerRankings = (teams: readonly RankingInput[]): TeamRanking[] => {
  const valueRanks = rankBy(teams, (t) => t.marketValue);
  const winsRanks = rankBy(teams, (t) => t.expectedWins);
  const titleRanks = rankBy(teams, (t) => t.titlePct);

  const threshold = divergenceThreshold(teams.length);

  return teams
    .map((team): TeamRanking => {
      const valueRank = valueRanks.get(team)!;
      const titleRank = titleRanks.get(team)!;
      const divergence = valueRank - titleRank;

      return {
        teamId: team.teamId,
        marketValue: team.marketValue,
        expectedWins: team.expectedWins,
        titlePct: team.titlePct,
        playoffPct: team.playoffPct,
        valueRank,
        winsRank: winsRanks.get(team)!,
        titleRank,
        divergence,
        signal:
          divergence >= threshold
            ? 'overachieving'
            : divergence <= -threshold
              ? 'stranded'
              : 'aligned',
      };
    })
    .sort((a, b) => b.titlePct - a.titlePct || b.expectedWins - a.expectedWins);
};
