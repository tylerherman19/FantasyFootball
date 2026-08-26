import type { Position } from '../domain/index.js';

export interface FundamentalPlayerInput {
  readonly position: Position;
  readonly age: number | undefined;
  readonly weeklyPoints: number;
  readonly replacementPoints: number;
  readonly marketValue: number;
  readonly years?: number;
}

export interface FundamentalValue {
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

/** Multi-year production above replacement, including career survival. */
export const fundamentalPlayerValue = (input: FundamentalPlayerInput): FundamentalValue => {
  const years = Math.max(1, input.years ?? 4);
  const age = input.age ?? PEAK[input.position];
  const annualSurplus: number[] = [];
  const survival: number[] = [];
  let total = 0;

  for (let year = 0; year < years; year += 1) {
    const futureAge = age + year;
    const yearsPastPeak = Math.max(0, futureAge - PEAK[input.position]);
    const production = input.weeklyPoints * (1 - ANNUAL_DECLINE[input.position]) ** yearsPastPeak;
    const survive = Math.max(0.15, Math.min(0.995, 0.985 - yearsPastPeak * ANNUAL_DECLINE[input.position]));
    const surplus = Math.max(0, production - input.replacementPoints) * 17 * survive;
    const discounted = surplus * 0.88 ** year;
    annualSurplus.push(discounted);
    survival.push(survive);
    total += discounted;
  }

  // Anchor football surplus to the market's value scale without letting the
  // market erase a genuine production/longevity disagreement.
  const productionValue = total * 18;
  return { total: 0.45 * input.marketValue + 0.55 * productionValue, annualSurplus, survival };
};

/** Picks are liquid and cannot age out before a rebuild is ready. */
export const fundamentalPickValue = (marketValue: number, yearsOut: number): number =>
  marketValue * 1.12 * 0.94 ** Math.max(0, yearsOut - 1);
