import type { TeamOutcome } from '../sim/season.js';

/**
 * Draft pick equity, valued from your own simulated finish.
 *
 * Every dynasty tool prices a future first-round pick off a generic chart — "a
 * 2027 1st is worth 2,400" — which is the same number whether the pick belongs
 * to the best team in the league or the worst. That is obviously wrong, and it
 * is wrong in the direction that matters: the picks people trade are exactly the
 * ones whose owners are about to finish very well or very badly.
 *
 * We already simulate the season ten thousand times and know the full
 * distribution over each team's final standing. Draft order is a function of
 * that standing, so pick equity falls out of the simulation for free — as a
 * distribution rather than a point estimate, which is the honest form given that
 * "my 2027 1st" is genuinely somewhere between pick 1 and pick 12.
 *
 * Converting slots to value needs a market curve, which is a data question and
 * not a modeling one, so it is injected. Without it we still report the slot
 * distribution, which is the part nobody else computes.
 */

export interface PickEquityInput {
  readonly outcome: TeamOutcome;
  readonly season: number;
  readonly round: number;
  readonly teamCount: number;
  /**
   * Value of an overall pick number, from whatever market curve the caller
   * trusts. Omit to get slot probabilities without a price.
   */
  readonly valueOfPick?: (overallPick: number) => number;
  /**
   * True when the draft order is worst-first — the near-universal fantasy
   * convention, and the reason a bad season has a silver lining.
   */
  readonly worstPicksFirst?: boolean;
}

export interface PickEquity {
  readonly season: number;
  readonly round: number;
  /** Expected slot within the round, 1-based. */
  readonly expectedSlot: number;
  /** Expected pick number counting from the top of the draft. */
  readonly expectedOverallPick: number;
  /** Probability of each slot, index 0 = slot 1. */
  readonly slotDistribution: readonly number[];
  /** Expected market value, when a curve was supplied. */
  readonly value: number | null;
  /**
   * Slots bounding the middle 80% of outcomes. The honest way to say "probably
   * a mid first, but it could be the 1.01".
   */
  readonly slotRange: readonly [number, number];
}

/** Slot at the given percentile of the distribution. */
const percentileSlot = (distribution: readonly number[], percentile: number): number => {
  let cumulative = 0;
  for (let i = 0; i < distribution.length; i += 1) {
    cumulative += distribution[i]!;
    if (cumulative >= percentile) return i + 1;
  }
  return distribution.length;
};

export const pickEquity = ({
  outcome,
  season,
  round,
  teamCount,
  valueOfPick,
  worstPicksFirst = true,
}: PickEquityInput): PickEquity => {
  // rankDistribution[i] is the probability of finishing (i+1)th. Worst-first
  // order reverses that into a draft slot.
  const ranks = outcome.rankDistribution.slice(0, teamCount);
  const slotDistribution: number[] = Array(teamCount).fill(0);

  ranks.forEach((probability, index) => {
    const finish = index + 1;
    const slot = worstPicksFirst ? teamCount - finish + 1 : finish;
    slotDistribution[slot - 1] = (slotDistribution[slot - 1] ?? 0) + probability;
  });

  // The simulation may not have covered every rank (a guillotine league, or a
  // team eliminated early), so renormalize rather than reporting an expectation
  // that quietly sums to less than one.
  const mass = slotDistribution.reduce((sum, p) => sum + p, 0);
  const normalized = mass > 0 ? slotDistribution.map((p) => p / mass) : slotDistribution;

  const expectedSlot = normalized.reduce((sum, p, index) => sum + p * (index + 1), 0);
  const picksBefore = (round - 1) * teamCount;

  const value =
    valueOfPick === undefined
      ? null
      : // Value the distribution, not the average slot. Pick value curves are
        // steeply convex at the top, so valuing the mean slot understates a pick
        // that has real probability of landing at 1.01.
        normalized.reduce((sum, p, index) => sum + p * valueOfPick(picksBefore + index + 1), 0);

  return {
    season,
    round,
    expectedSlot,
    expectedOverallPick: picksBefore + expectedSlot,
    slotDistribution: normalized,
    value,
    slotRange: [percentileSlot(normalized, 0.1), percentileSlot(normalized, 0.9)],
  };
};
