import type { DraftPickAsset, LeagueSnapshot } from '../domain/index.js';
import type { SeasonSimResult } from '../sim/season.js';

/**
 * Draft pick valuation.
 *
 * In dynasty leagues picks are traded constantly, and a trade tool that ignores
 * them can only price half the market. But a pick's worth is not a constant —
 * "a 2027 first" is a top-three selection if the team holding it is collapsing
 * and a late one if they're contending, and those differ by multiples.
 *
 * The simulator already answers that question: it returns, for every team, the
 * distribution over where they finish. Weighting slot values by that
 * distribution prices each pick against the specific team that will produce it,
 * which is the whole reason a rebuilding team's first is worth chasing.
 */

export interface PickValueSource {
  /** Value of an exact slot in the next draft, e.g. round 1 pick 4. */
  exactSlot(round: number, slot: number): number | undefined;
  /** Value of a future pick by tier, when the draft order is not yet known. */
  tier(season: number, round: number, tier: 'early' | 'mid' | 'late'): number | undefined;
}

export interface ValuedPick {
  readonly season: number;
  readonly round: number;
  readonly originalTeamId: string;
  readonly ownerTeamId: string;
  readonly value: number;
  /** Expected pick number within the round, 1-indexed. */
  readonly expectedSlot: number;
  readonly description: string;
}

/**
 * Every pick each team currently holds.
 *
 * A team owns its own picks in every future season unless a trade moved them,
 * and platforms only report the exceptions — so ownership is reconstructed by
 * starting from "everyone owns their own" and applying the trades on top.
 */
export const pickInventory = (
  snapshot: LeagueSnapshot,
  seasons: readonly number[],
  rounds: readonly number[],
): DraftPickAsset[] => {
  const traded = new Map<string, string>();
  for (const pick of snapshot.draftPicks) {
    traded.set(`${pick.season}:${pick.round}:${pick.originalTeamId}`, pick.ownerTeamId);
  }

  const inventory: DraftPickAsset[] = [];

  for (const season of seasons) {
    for (const round of rounds) {
      for (const roster of snapshot.rosters) {
        const key = `${season}:${round}:${roster.teamId}`;
        inventory.push({
          season,
          round,
          originalTeamId: roster.teamId,
          ownerTeamId: traded.get(key) ?? roster.teamId,
        });
      }
    }
  }

  return inventory;
};

/** Where a season's draft order comes from, and how confident we are in it. */
const tierFor = (expectedSlot: number, teamCount: number): 'early' | 'mid' | 'late' => {
  const third = teamCount / 3;
  if (expectedSlot <= third) return 'early';
  if (expectedSlot <= third * 2) return 'mid';
  return 'late';
};

/**
 * Price picks using each team's simulated finish.
 *
 * Draft order is assumed to be the reverse of final standings, which is the
 * common default — leagues using a lottery or an offline order will differ, and
 * that assumption is surfaced in the UI rather than buried here.
 */
export const valuePicks = (
  picks: readonly DraftPickAsset[],
  simulation: SeasonSimResult,
  snapshot: LeagueSnapshot,
  values: PickValueSource,
): ValuedPick[] => {
  const teamCount = snapshot.rosters.length;

  // Expected finishing rank per team, from the rank distribution. Reverse of
  // that is the draft slot.
  const expectedSlotByTeam = new Map<string, number>();
  for (const team of simulation.teams) {
    const expectedRank = team.rankDistribution.reduce(
      (sum, share, index) => sum + share * (index + 1),
      0,
    );
    // Worst team picks first: slot = teamCount + 1 - rank.
    expectedSlotByTeam.set(team.teamId, Math.max(1, teamCount + 1 - expectedRank));
  }

  const nextSeason = snapshot.league.season + 1;

  return picks.flatMap((pick): ValuedPick[] => {
    const expectedSlot = expectedSlotByTeam.get(pick.originalTeamId) ?? teamCount / 2;

    // The immediately upcoming draft is the one whose order we can actually
    // project; later ones get tier pricing, because a projection three seasons
    // out is fiction.
    const value =
      pick.season === nextSeason
        ? values.exactSlot(pick.round, Math.round(expectedSlot))
        : values.tier(pick.season, pick.round, tierFor(expectedSlot, teamCount));

    if (value === undefined) return [];

    const ordinal = pick.round === 1 ? '1st' : pick.round === 2 ? '2nd' : pick.round === 3 ? '3rd' : `${pick.round}th`;
    const owned = pick.originalTeamId === pick.ownerTeamId;

    return [
      {
        season: pick.season,
        round: pick.round,
        originalTeamId: pick.originalTeamId,
        ownerTeamId: pick.ownerTeamId,
        value,
        expectedSlot,
        description:
          `${pick.season} ${ordinal}` +
          (owned ? '' : ' (via trade)') +
          ` · projects ${pick.round}.${String(Math.round(expectedSlot)).padStart(2, '0')}`,
      },
    ];
  });
};
