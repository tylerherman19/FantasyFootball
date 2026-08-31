import type { Position } from '../domain/index.js';

/**
 * A player's football value, decomposed year by year.
 *
 * This used to end on a line that blended the answer with a purchased one:
 *
 *     return 0.45 * marketValue + 0.55 * productionValue
 *
 * That was the right hedge while the market came from somewhere else. A public
 * consensus knows things a projection does not — a coaching change, a contract,
 * a beat writer's report — and refusing to listen to it would have been
 * arrogance rather than rigour.
 *
 * It is the wrong hedge now. `valuation/market.ts` derives the market value
 * from the same projections this function starts from, so the blend averages a
 * number with itself, weights the result 45/55 for no reason anyone could
 * defend, and — worst — hides the disagreement it was introduced to preserve.
 * When two independent estimates disagree that is information; when one is
 * built from the other it is arithmetic.
 *
 * So this does one job now: say what the next few years look like, season by
 * season, with aging and attrition priced separately so a reader can see which
 * is doing the work. The headline index lives in `valueAssets`, and the two
 * agree because they are the same model seen at two resolutions.
 */

export interface FundamentalPlayerInput {
  readonly position: Position;
  readonly age: number | undefined;
  readonly weeklyPoints: number;
  readonly replacementPoints: number;
  readonly years?: number;
  /**
   * Production in each future season as a share of this one, from the fitted
   * age curves. Supply it wherever the curves reach: measured decline beats the
   * positional constants below, which exist only so a player the curves cannot
   * place still gets an answer.
   */
  readonly futureSeasons?: readonly number[];
}

export interface FundamentalValue {
  /** Discounted points above replacement across the horizon. */
  readonly total: number;
  readonly annualSurplus: readonly number[];
  readonly survival: readonly number[];
}

const PEAK: Readonly<Record<Position, number>> = {
  QB: 28, RB: 24, WR: 26, TE: 27, K: 29, DEF: 0, DL: 26, LB: 26, DB: 25,
};

const ANNUAL_DECLINE: Readonly<Record<Position, number>> = {
  QB: 0.055, RB: 0.16, WR: 0.09, TE: 0.08, K: 0.08, DEF: 0.12, DL: 0.13, LB: 0.12, DB: 0.14,
};

/** Per-season discount, matching `valuation/market.ts` so the two cannot drift. */
const DISCOUNT = 0.88;

/**
 * Multi-year production above replacement, including career survival.
 *
 * Survival and decline are separate multipliers because they are separate
 * facts. A 30-year-old back is worth less both because the carries he gets are
 * worth less *and* because he may not be rostered at all, and a single "decline"
 * number that quietly contains both cannot be checked against either.
 */
export const fundamentalPlayerValue = (input: FundamentalPlayerInput): FundamentalValue => {
  const years = Math.max(1, input.years ?? 4);
  const age = input.age ?? PEAK[input.position];
  const annualSurplus: number[] = [];
  const survival: number[] = [];
  let total = 0;

  for (let year = 0; year < years; year += 1) {
    const futureAge = age + year;
    const yearsPastPeak = Math.max(0, futureAge - PEAK[input.position]);

    // Measured where we have it, asserted only where we do not.
    const fitted = year === 0 ? 1 : input.futureSeasons?.[year - 1];
    const share =
      fitted ?? (1 - ANNUAL_DECLINE[input.position]) ** yearsPastPeak;

    const production = input.weeklyPoints * share;
    const survive = Math.max(0.15, Math.min(0.995, 0.985 - yearsPastPeak * ANNUAL_DECLINE[input.position]));
    const surplus = Math.max(0, production - input.replacementPoints) * 17 * survive;
    const discounted = surplus * DISCOUNT ** year;
    annualSurplus.push(discounted);
    survival.push(survive);
    total += discounted;
  }

  return { total, annualSurplus, survival };
};

/**
 * Picks are liquid and cannot age out before a rebuild is ready.
 *
 * The premium is small and it is not a claim that picks outproduce players. It
 * prices optionality: a pick can become any position, can be traded at any
 * point in the cycle, and carries none of the risk that the specific player you
 * would otherwise hold gets hurt in September.
 */
export const fundamentalPickValue = (pickValue: number, yearsOut: number): number =>
  pickValue * 1.12 * 0.94 ** Math.max(0, yearsOut - 1);
