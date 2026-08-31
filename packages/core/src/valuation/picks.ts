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

/**
 * Price the rookie draft off our own valuation of the class in it.
 *
 * The feed this replaces published a fixed table of pick values — "a 2027 1.03
 * is worth 4,200" — which is a statement about rookie picks in general and
 * cannot be a statement about *this* draft. Some classes are top-heavy and some
 * are flat, and in a flat one the 1.03 and the 1.09 are nearly the same asset.
 * A static chart prices them as if they never are.
 *
 * We already value every incoming rookie, from draft capital and the rookie
 * prior, in the same units as every veteran. So a pick is priced as what it
 * actually is: a claim on a player from a class we have already assessed.
 *
 * Two things separate a pick from the player it becomes, and both belong here.
 *
 * **You do not get the player you ranked there.** Rookie draft order tracks our
 * ordering loosely and no further; managers reach, and the board falls
 * differently every year. So a slot is priced as a weighted average over the
 * players plausibly available at it, not as the one we happen to rank at that
 * number. The spread widens with depth, because the eighth pick is far less
 * predictable than the first — which is also why the resulting curve is steep
 * at the top and flat by the third round, the shape every published pick chart
 * has, arrived at rather than assumed.
 *
 * **A future pick is a pick in a draft nobody has scouted.** Its class is
 * unknown, and so is the slot, so it is priced from the shape of the class we
 * can see and discounted for the wait.
 */
export interface ModelPickOptions {
  /** Teams in the league — how many picks are in a round. */
  readonly teamCount: number;
  /** Per-year discount on picks in drafts beyond the next one. */
  readonly discount?: number;
}

const FUTURE_DISCOUNT = 0.9;

/**
 * Expected value at an overall rookie-draft slot.
 *
 * `pick` is 1-indexed. The kernel is deliberately wide and gets wider: two
 * ranks of uncertainty at the top of the first round, roughly a third of the
 * pick number by the end of the draft.
 */
const expectedAt = (values: readonly number[], pick: number): number => {
  if (values.length === 0) return 0;

  const centre = pick - 1;
  const spread = Math.max(1.5, 0.35 * pick);

  let weighted = 0;
  let total = 0;

  for (let rank = 0; rank < values.length; rank += 1) {
    const z = (rank - centre) / spread;
    if (Math.abs(z) > 4) continue;
    const weight = Math.exp(-0.5 * z * z);
    weighted += weight * values[rank]!;
    total += weight;
  }

  // Past the end of the class the kernel runs off the board. What is left there
  // is not a player, so the tail decays to nothing rather than flattening onto
  // the last rookie we happened to value.
  return total > 0 ? weighted / total : 0;
};

/**
 * A pick value source built from this class, not from a table.
 *
 * `rookieValues` is the incoming class in our own index units, best first.
 */
export const modelPickValues = (
  rookieValues: readonly number[],
  nextSeason: number,
  options: ModelPickOptions,
): PickValueSource => {
  const teams = Math.max(2, Math.round(options.teamCount));
  const discount = options.discount ?? FUTURE_DISCOUNT;
  const sorted = [...rookieValues].sort((a, b) => b - a);

  const overall = (round: number, slot: number): number => (round - 1) * teams + slot;

  return {
    exactSlot: (round, slot) => expectedAt(sorted, overall(round, slot)),

    tier: (season, round, tier) => {
      // The middle of the tier, since which third of the round a pick lands in
      // is the most we claim to know about a draft that has not happened.
      const within = tier === 'early' ? teams / 6 : tier === 'mid' ? teams / 2 : (5 * teams) / 6;
      const yearsOut = Math.max(1, season - nextSeason + 1);
      return expectedAt(sorted, overall(round, Math.round(within))) * discount ** (yearsOut - 1);
    },
  };
};
