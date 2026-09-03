import type { LineupSlot, PlayerId, Position } from '../domain/index.js';
import { SLOT_ELIGIBILITY } from '../domain/index.js';

/**
 * Edge value — the model's own price for a player, in points above replacement.
 *
 * Every other number in this repository is measured from its own data; the one
 * that was not was the price. Market value came from FantasyCalc, an external
 * feed whose outage made trade suggestions silently disappear and whose scale
 * (0-9999) had leaked into thresholds all over the decision layer. This module
 * is the replacement: the same projections, age curves and league settings the
 * rest of the product already uses, combined into a price with no external
 * dependency at all.
 *
 * The currency is PAR — points above replacement. A player is worth what he
 * scores above the best player you could pick up for free, because that is the
 * definition of what a roster spot buys. Everything else (name, draft capital,
 * hype) is a story about future PAR, and the parts of those stories that are
 * real are already inside the projection.
 *
 * Two horizons, because the formats price different things:
 *
 * - Redraft / guillotine: value = PAR for the rest of *this* season. A
 *   30-year-old and a 23-year-old with the same projection are worth the same,
 *   because in redraft they are.
 * - Dynasty / keeper: value = PAR across the next four seasons, with future
 *   years walked along the *measured* age curves (model/artifacts/age-curves.json,
 *   delta method, 2016-2025) rather than a hand-set decline table. The 45/55
 *   market anchor the old `fundamental.ts` applied is gone entirely.
 *
 * What this deliberately does not do: it does not try to predict what other
 * managers will *accept*. Acceptance stays with the trade evaluation's odds
 * and fit signals, which is where the repository already answers "is this good
 * for me." FantasyCalc remains available as an optional sanity comparison
 * (scripts/value-sanity.mts) and nothing more.
 */

export interface EdgeValuePlayer {
  readonly playerId: PlayerId;
  readonly position: Position;
  /** Weekly projection under this league's own scoring, in fantasy points. */
  readonly weeklyPoints: number;
  /** Games left to play this regular season, byes already removed. */
  readonly gamesRemaining: number;
  readonly age?: number;
  /** Draft slot, for rookies: feeds the pick chart. */
  readonly draftOverall?: number;
  /** How this projection was produced — rookie priors feed the pick chart. */
  readonly basis?: 'history' | 'rookie-prior';
}

/** Minimal structural view of the measured age-curve artifact. */
export interface AgeCurveData {
  readonly curves: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface EdgeValueContext {
  /** Dynasty and keeper price the future; redraft and guillotine price now. */
  readonly dynasty: boolean;
  /** How many starter slots each team fields per position (flex expanded). */
  readonly startersByPosition: Readonly<Record<string, number>>;
  readonly teamCount: number;
  /** Seasons of future production a dynasty price spans. */
  readonly horizonYears?: number;
  /** Games in a full fantasy regular season, for annualizing PAR. */
  readonly gamesPerSeason?: number;
  readonly ageCurves?: AgeCurveData | null;
}

export interface EdgeValuation {
  readonly playerId: PlayerId;
  readonly position: Position;
  /** Weekly points above this league's replacement level. Never negative. */
  readonly weeklyPar: number;
  /** The replacement level used, in weekly points, so the number is checkable. */
  readonly replacementPoints: number;
  /** PAR over the rest of this season. */
  readonly rosValue: number;
  /** PAR across the next `horizonYears` seasons, age-curve walked. */
  readonly dynastyValue: number;
  /** Sum of expected production ratios over the horizon (1 = this year only). */
  readonly multiYear: number;
  /** The price, in the format-appropriate currency. */
  readonly value: number;
  /** Rank among all valued players, 1 = most valuable. */
  readonly overallRank: number;
}

const DEFAULT_HORIZON = 4;
const DEFAULT_SEASON_GAMES = 17;

/**
 * Starter demand per position from the actual lineup slots.
 *
 * Dedicated slots count in full. Shared slots (FLEX, SUPER_FLEX, IDP_FLEX)
 * are divided among their eligible positions in proportion to how many
 * dedicated starters those positions already field — a flex in a 2RB/3WR
 * league is mostly a WR slot, and pretending it is split evenly would price
 * running back scarcity wrong. This split is a modelling choice, not a
 * measured constant; it is the one asserted number in the module and it is
 * confined to this function.
 */
export const starterDemand = (
  rosterSlots: readonly LineupSlot[],
  teamCount: number,
): Record<string, number> => {
  const dedicated = new Map<Position, number>();
  const shared: { slot: LineupSlot; eligible: readonly Position[] }[] = [];

  for (const slot of rosterSlots) {
    const eligible = SLOT_ELIGIBILITY[slot];
    if (eligible === null) continue;
    // A superflex slot is a quarterback slot in practice: QB is the
    // highest-scoring eligible position, so the slot starts one whenever a
    // team has two. Treating it as an even four-way split would underprice QB
    // scarcity — the defining feature of the format. This is a modelling
    // choice, stated rather than hidden.
    if (slot === 'SUPER_FLEX') {
      dedicated.set('QB', (dedicated.get('QB') ?? 0) + 1);
      continue;
    }
    if (eligible.length === 1) {
      dedicated.set(eligible[0]!, (dedicated.get(eligible[0]!) ?? 0) + 1);
    } else {
      shared.push({ slot, eligible });
    }
  }

  const demand: Record<string, number> = {};
  for (const [position, count] of dedicated) demand[position] = count * teamCount;

  for (const { eligible } of shared) {
    const weights = eligible.map((p) => Math.max(0.5, dedicated.get(p) ?? 0));
    const total = weights.reduce((a, b) => a + b, 0);
    eligible.forEach((position, i) => {
      demand[position] = (demand[position] ?? 0) + (teamCount * weights[i]!) / total;
    });
  }

  return demand;
};

/**
 * Replacement level per position, read off the actual player pool.
 *
 * The replacement player is the best one who would not start for anyone: with
 * 36 starting running back slots, he is the 37th-best back by projection.
 * Measured against the whole pool (rostered and free), because that is who is
 * actually available — and it moves on its own when injuries thin a position,
 * which a hardcoded points table cannot do.
 *
 * The rank is rounded down and clamped into the pool: a league with more
 * starting slots than projected players gets the worst projected player, not
 * an imaginary one.
 */
export const replacementLevels = (
  players: readonly EdgeValuePlayer[],
  startersByPosition: Readonly<Record<string, number>>,
): Record<string, number> => {
  const byPosition = new Map<string, number[]>();
  for (const player of players) {
    const bucket = byPosition.get(player.position) ?? [];
    bucket.push(player.weeklyPoints);
    byPosition.set(player.position, bucket);
  }

  const levels: Record<string, number> = {};
  for (const [position, points] of byPosition) {
    points.sort((a, b) => b - a);
    const rank = Math.max(1, Math.floor(startersByPosition[position] ?? 0));
    // The first non-starter: with `rank` starting slots, index `rank` is the
    // best player nobody starts. Clamp into the pool, not beyond it.
    const index = Math.min(rank, points.length - 1);
    levels[position] = points[index]!;
  }
  return levels;
};

/** Share-of-peak at an age, interpolated — mirrors the artifact's own reading. */
const shareOfPeak = (curves: AgeCurveData, position: string, age: number): number | null => {
  const curve = curves.curves[position];
  if (curve === undefined) return null;

  const ages = Object.keys(curve)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (ages.length === 0) return null;

  const first = ages[0]!;
  const last = ages[ages.length - 1]!;
  if (age <= first) return curve[String(first)] ?? null;

  if (age > last) {
    /*
     * Beyond the measured endpoint, follow the curve's own final segment —
     * never above its final share.
     *
     * A flat clamp here inverted age preference exactly where the sample runs
     * out: every year past the endpoint priced like the endpoint year, so a
     * 36-year-old's four-season walk totalled more than a 30-year-old's. The
     * final segment's slope is measured, not asserted; capping it at zero
     * means "extend the decline the data showed," never "invent growth." A
     * curve that ends flat (QB, where the sample thins) stays flat — the
     * honest "we don't know," stated in the module docs.
     */
    const prev = ages[ages.length - 2] ?? first;
    const lastShare = curve[String(last)];
    const prevShare = curve[String(prev)];
    if (lastShare === undefined || prevShare === undefined) return null;
    const slope = Math.min(0, (lastShare - prevShare) / (last - prev));
    return Math.max(0, lastShare + slope * (age - last));
  }

  const upper = ages.find((n) => n >= age)!;
  const lower = ages[ages.indexOf(upper) - 1] ?? upper;
  if (upper === lower) return curve[String(upper)] ?? null;

  const low = curve[String(lower)];
  const high = curve[String(upper)];
  if (low === undefined || high === undefined) return null;
  const t = (age - lower) / (upper - lower);
  return low + (high - low) * t;
};

/**
 * Expected production over the horizon as a multiple of this season.
 *
 * Walks the measured curve year by year: a 24-year-old back reads ~3.4 over
 * four years, a 28-year-old ~2.1, and the two are directly comparable. Years
 * the curve cannot reach follow the curve's own final measured slope, capped
 * so it can only fall (quarterbacks past 27, where the sample runs out, end
 * flat and stay flat — the QB curve's own documentation says it cannot answer
 * there). Positions with no curve at all (K, DEF, IDP) are flat by the same
 * argument.
 *
 * Undiscounted, deliberately: how much sooner-is-better matters is a stance
 * decision the contend-or-rebuild read makes explicitly; baking a discount
 * rate in here would make that judgement twice, silently.
 */
export const multiYearMultiplier = (
  curves: AgeCurveData | null | undefined,
  position: string,
  age: number | undefined,
  years: number,
): number => {
  if (curves == null || age === undefined) return years;
  const now = shareOfPeak(curves, position, age);
  // No curve for the position: flat, per the module docs.
  if (now === null) return years;
  // The curve has run him out entirely (share at or past the zero crossing):
  // what remains is this season, and only this season. Falling back to
  // `years` here re-inverted the pricing — a 34-year-old past the crossing
  // read as four full future seasons, worse than the flat clamp ever was.
  if (now <= 0) return 1;

  let total = 1;
  for (let offset = 1; offset < years; offset += 1) {
    const later = shareOfPeak(curves, position, age + offset);
    total += later === null ? 1 : later / now;
  }
  return total;
};

/**
 * Price every player in the pool.
 *
 * Players below replacement level price at zero. That is not a gap in the
 * model, it is the answer: a player you could replace for free is worth what
 * the waiver wire charges for him. Nothing downstream may treat zero as
 * "missing" — absence from the map means unpriced, zero means freely
 * available, and the two are different statements.
 */
export const edgeValues = (
  players: readonly EdgeValuePlayer[],
  context: EdgeValueContext,
): Map<PlayerId, EdgeValuation> => {
  const horizon = context.horizonYears ?? DEFAULT_HORIZON;
  const seasonGames = context.gamesPerSeason ?? DEFAULT_SEASON_GAMES;
  const replacement = replacementLevels(players, context.startersByPosition);

  const valuations = players.map((player): EdgeValuation => {
    const replacementPoints = replacement[player.position] ?? 0;
    const weeklyPar = Math.max(0, player.weeklyPoints - replacementPoints);
    const multiYear = context.dynasty
      ? multiYearMultiplier(context.ageCurves, player.position, player.age, horizon)
      : 1;

    const rosValue = weeklyPar * player.gamesRemaining;
    const dynastyValue = weeklyPar * seasonGames * multiYear;

    return {
      playerId: player.playerId,
      position: player.position,
      weeklyPar,
      replacementPoints,
      rosValue,
      dynastyValue,
      multiYear,
      value: context.dynasty ? dynastyValue : rosValue,
      overallRank: 0,
    };
  });

  valuations.sort((a, b) => b.value - a.value || a.position.localeCompare(b.position));

  return new Map(
    valuations.map((valuation, index) => [
      valuation.playerId,
      { ...valuation, overallRank: index + 1 },
    ]),
  );
};

// ---------------------------------------------------------------------------
// Pick pricing
// ---------------------------------------------------------------------------

export interface EdgePickChart {
  /** Expected dynasty value of the player taken at an exact overall slot. */
  valueAtSlot(slot: number): number;
  /** Expected value of a rookie drafted at this slot per current class evidence. */
  readonly classSize: number;
}

/**
 * A draft-pick chart from the model's own rookie projections.
 *
 * The old chart came from FantasyCalc's labels ("2027 1st (Early)"), which is
 * the market telling you what picks cost. This one asks the model instead:
 * every rookie in the pool already carries a projection from
 * model/models/rookie_prior.py, fitted against draft slot over ten completed
 * classes. Ordering this class by draft slot and reading off their dynasty
 * values prices slot N as "what the Nth rookie is expected to be worth" —
 * the same relationship, computed rather than borrowed.
 *
 * The relationship is fitted log-linear (value falls off roughly as a power of
 * draft position) rather than read point-by-point, because one class is noisy:
 * the fit is the curve the model actually believes, and individual busts and
 * hits average out of it.
 *
 * Future drafts price off the same curve. Class strength varies year to year
 * and the current class is the model's best estimate of an average one; that
 * assumption is stated in the UI rather than buried here.
 */
export const edgePickChart = (
  rookies: readonly { draftOverall: number; dynastyValue: number }[],
): EdgePickChart | null => {
  // Zero-value rookies stay in: a projected bust at slot 40 is evidence about
  // slot 40. Fitting only positive values would price late picks as if every
  // rookie hits, which is exactly the optimism a pick chart exists to avoid.
  // The fit runs on log1p so the zeros are representable.
  const usable = rookies.filter((r) => r.draftOverall >= 1 && r.dynastyValue >= 0);
  if (usable.length < 8) return null;

  const xs = usable.map((r) => Math.log(r.draftOverall));
  const ys = usable.map((r) => Math.log1p(r.dynastyValue));
  const n = usable.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
    sxx += (xs[i]! - meanX) ** 2;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  return {
    classSize: usable.length,
    valueAtSlot: (slot) => Math.max(0, Math.expm1(intercept + slope * Math.log(Math.max(1, slot)))),
  };
};

/**
 * A PickValueSource backed by the model's own chart.
 *
 * Same contract as the old market source: exact slots for the upcoming draft,
 * tiers beyond it. Tier midpoints price the tier — "early" is the middle of
 * the top third, not its best case, because an expected finish is a
 * distribution and pricing to the best case would overpay for bad teams'
 * picks systematically.
 */
export const edgePickValues = (
  chart: EdgePickChart,
  teamCount: number,
): {
  exactSlot(round: number, slot: number): number | undefined;
  tier(season: number, round: number, tier: 'early' | 'mid' | 'late'): number | undefined;
} => ({
  exactSlot: (round, slot) => {
    if (round < 1 || slot < 1) return undefined;
    return chart.valueAtSlot((round - 1) * teamCount + slot);
  },
  tier: (_season, round, tier) => {
    const third = teamCount / 3;
    const midpoints = { early: (1 + third) / 2, mid: (third + 2 * third) / 2, late: (2 * third + teamCount) / 2 };
    const slot = midpoints[tier];
    return chart.valueAtSlot((round - 1) * teamCount + slot);
  },
});
