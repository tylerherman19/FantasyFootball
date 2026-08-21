import { readArtifactFile } from './projections';

/**
 * Where a player sits on his position's aging curve, measured not asserted.
 *
 * This replaces a table of hand-set decline ages — the exact pattern the brief
 * calls out as "RB over 27 = bad". Those numbers were not wrong so much as
 * stated at the wrong resolution: a single threshold cannot distinguish a
 * 27-year-old workhorse from a 27-year-old committee back, and it changes
 * discontinuously on a birthday.
 *
 * The curves come from `model/models/age_curves.py`, fitted by the delta method
 * — each player compared to himself a year later, so his own level cancels and
 * only the age effect survives. Population averages by age measure survivorship
 * instead: the 32-year-olds still playing are the ones good enough to still be
 * playing, which bends the curve upward exactly where careers end.
 *
 * **Read these as a floor on decline, not a neutral estimate.** The delta method
 * still conditions on a player surviving into the second season, so it
 * understates how fast a cohort actually falls off. The artifact says so too.
 */

export interface AgeTransition {
  readonly position: string;
  readonly from_age: number;
  readonly ratio: number;
  readonly pairs: number;
  /** Spread of individual ratios: how much players differ from the average. */
  readonly ratio_sd: number;
  /** Standard error of the median: how well we know the average. */
  readonly ratio_se: number;
}

export interface AgeCurves {
  readonly generatedAt: string;
  readonly caveat: string;
  /** position -> age (as string) -> share of that position's peak production. */
  readonly curves: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly transitions?: readonly AgeTransition[];
}

let cache: AgeCurves | null | undefined;

export const loadAgeCurves = async (): Promise<AgeCurves | null> => {
  if (cache !== undefined) return cache;

  try {
    const raw = await readArtifactFile('age-curves.json');
    cache = raw === null ? null : (JSON.parse(raw) as AgeCurves);
  } catch {
    cache = null;
  }
  return cache;
};

/**
 * Expected production at `age`, as a share of this position's peak.
 *
 * Interpolates between integer ages, because a player is not the same on either
 * side of a birthday and a step function would make dynasty value jump for no
 * football reason. Outside the fitted range it clamps to the nearest end rather
 * than extrapolating — the sample thins fast at both extremes, and a
 * quarterback curve that only reaches 27 should say "I don't know" about 34
 * rather than invent a number.
 */
export const shareOfPeak = (
  curves: AgeCurves | null,
  position: string,
  age: number | null,
): number | null => {
  if (curves === null || age === null) return null;

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
  if (age >= last) return curve[String(last)] ?? null;

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
 * How much of a player's peak remains over the next `years`, in aggregate.
 *
 * This is the number a dynasty decision actually turns on. "He is 28" is not
 * actionable; "the model expects 2.4 peak-equivalent seasons out of him over
 * the next four" is, and it is directly comparable to a younger player's 3.6.
 */
export const remainingPeakSeasons = (
  curves: AgeCurves | null,
  position: string,
  age: number | null,
  years = 4,
): number | null => {
  if (age === null) return null;

  let total = 0;
  let known = false;
  for (let offset = 0; offset < years; offset += 1) {
    const share = shareOfPeak(curves, position, age + offset);
    if (share === null) continue;
    known = true;
    total += share;
  }
  return known ? total : null;
};

/** Whether a player is before, at, or past his position's peak. */
export const careerPhase = (
  curves: AgeCurves | null,
  position: string,
  age: number | null,
): 'ascending' | 'peak' | 'declining' | null => {
  if (curves === null || age === null) return null;

  const now = shareOfPeak(curves, position, age);
  const next = shareOfPeak(curves, position, age + 1);
  if (now === null || next === null) return null;

  if (next > now + 0.02) return 'ascending';
  if (next < now - 0.02) return 'declining';
  return 'peak';
};

/**
 * The age at which a position has measurably fallen off its peak.
 *
 * This exists to replace a hand-set table — QB 34, RB 27, WR 29, TE 30 — with
 * the same quantity read off the fitted curve. The threshold is explicit and
 * arguable, which is the improvement: "the age at which an average back is
 * below 75% of his peak" is a claim you can check, where "27" is one you can
 * only accept.
 *
 * Returns null when the curve never crosses the threshold inside its fitted
 * range. Quarterbacks do that here — the sample thins past 27 and the curve
 * stops before any real decline — and null is the correct answer, not an
 * extrapolated guess. Callers fall back to the asserted table and are expected
 * to say so.
 */
export const declineAge = (
  curves: AgeCurves | null,
  position: string,
  threshold = 0.75,
): number | null => {
  if (curves === null) return null;

  const curve = curves.curves[position];
  if (curve === undefined) return null;

  const ages = Object.keys(curve)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const peakAge = ages.reduce(
    (best, n) => ((curve[String(n)] ?? 0) > (curve[String(best)] ?? 0) ? n : best),
    ages[0] ?? 0,
  );

  // Only look after the peak: a 21-year-old below threshold is ascending, not
  // declining, and treating him as past it would be exactly backwards.
  for (const n of ages) {
    if (n <= peakAge) continue;
    if ((curve[String(n)] ?? 1) < threshold) return n;
  }
  return null;
};

/** The age a position produces most, measured. */
export const peakAge = (curves: AgeCurves | null, position: string): number | null => {
  if (curves === null) return null;
  const curve = curves.curves[position];
  if (curve === undefined) return null;

  const ages = Object.keys(curve)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (ages.length === 0) return null;

  return ages.reduce((best, n) => ((curve[String(n)] ?? 0) > (curve[String(best)] ?? 0) ? n : best), ages[0]!);
};

/**
 * A player's expected production for each of the next `years` seasons, as a
 * share of his *current* level rather than of his position's peak.
 *
 * This is the shape dynasty valuation needs. "He is at 82% of peak" is a fact
 * about the position; "he will be worth 0.91 of what he is now next year and
 * 0.68 in three years" is a fact about him, and it is what makes two players
 * comparable when they are at different points on the same curve.
 *
 * Returns nulls for years the curve cannot reach, rather than flattening them
 * to 1.0 — a quarterback whose curve stops at 27 should produce an absent
 * number for his age-33 season, not a confident one.
 */
export const yearByYearOutlook = (
  curves: AgeCurves | null,
  position: string,
  age: number | null,
  years = 5,
): (number | null)[] => {
  const now = shareOfPeak(curves, position, age);
  if (now === null || now <= 0 || age === null) return Array<number | null>(years).fill(null);

  return Array.from({ length: years }, (_, offset) => {
    const later = shareOfPeak(curves, position, age + offset + 1);
    return later === null ? null : later / now;
  });
};

/**
 * Multi-year value, as a multiple of one current season.
 *
 * Sums the year-by-year outlook, so a 23-year-old back reading 3.4 over four
 * years and a 28-year-old reading 2.1 are directly comparable in the only
 * currency that matters — seasons of production still to come, priced at what
 * each player is worth today.
 *
 * Deliberately *not* discounted. A discount rate encodes how much sooner-is-
 * better matters to a particular manager in a particular season, which is a
 * decision the contend-or-rebuild read already makes explicitly. Baking one in
 * here would make that judgement twice, silently, and in the wrong place.
 */
export const multiYearValue = (
  curves: AgeCurves | null,
  position: string,
  age: number | null,
  years = 4,
): number | null => {
  const outlook = yearByYearOutlook(curves, position, age, years);
  const known = outlook.filter((v): v is number => v !== null);
  return known.length === 0 ? null : 1 + known.reduce((a, b) => a + b, 0);
};


// ---------------------------------------------------------------------------
// Probabilistic multi-year value (§20)
// ---------------------------------------------------------------------------

export interface ValueDistribution {
  readonly median: number;
  readonly p10: number;
  readonly p25: number;
  readonly p75: number;
  readonly p90: number;
  /** Chance he is still worth at least this share of today by the final year. */
  readonly survivalOdds: number;
  readonly years: number;
}

/**
 * Multi-year value as a distribution rather than a number (§20).
 *
 * The point estimate this replaces walked the median curve and summed it, which
 * silently asserts that every 24-year-old back ages like the average
 * 24-year-old back. They do not, and the data says so loudly: the year-over-year
 * ratio for backs has a spread of roughly 0.4-0.5 around a median near 0.9.
 * Aging is a population tendency, not a schedule.
 *
 * So each simulated career samples its own path — one draw per year from that
 * year's measured transition — and the spread of the resulting totals is the
 * honest answer to "what is he worth over four years".
 *
 * Two sources of uncertainty, and they are not the same thing:
 *
 * - `ratio_sd` — how much individual players differ from the average. This is
 *   the big one, and it does not shrink with more data because it is real
 *   variation between players rather than ignorance about them.
 * - `ratio_se` — how well the average itself is known. Small where the sample
 *   is large, and it is the part that improves as seasons accumulate.
 *
 * Both are sampled: the second once per simulated career (the curve is either
 * right or wrong, consistently), the first once per year (each season is its
 * own roll). Treating them alike would understate the spread.
 *
 * Seeded, so the same player yields the same distribution on every render and a
 * number on the page does not change when you refresh it.
 */
export const simulateMultiYearValue = (
  curves: AgeCurves | null,
  position: string,
  age: number | null,
  years = 4,
  iterations = 2000,
  seed = 1,
): ValueDistribution | null => {
  if (curves === null || age === null) return null;

  const transitions = curves.transitions;
  if (transitions === undefined || transitions.length === 0) return null;

  const byAge = new Map<number, AgeTransition>();
  for (const t of transitions) {
    if (t.position === position) byAge.set(t.from_age, t);
  }
  if (byAge.size === 0) return null;

  // Small deterministic PRNG: mulberry32. Local rather than imported from core
  // because core is the simulation engine and this is a page-level estimate.
  let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (): number => {
    // Box-Muller. One draw discarded per call is cheaper than caching here.
    const u = Math.max(1e-12, random());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };

  const totals: number[] = [];
  const finals: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    // One curve-level error per career: if the fitted median is off, it is off
    // for every year of this player's future, not independently each season.
    const curveError = normal();

    let level = 1;
    let total = 1;
    let known = true;

    for (let year = 0; year < years; year += 1) {
      const transition = byAge.get(Math.floor(age) + year);
      if (transition === undefined) {
        known = false;
        break;
      }

      const ratio = transition.ratio + curveError * transition.ratio_se + normal() * transition.ratio_sd;
      // A season cannot be negative, and no player triples year over year in a
      // way worth propagating through a four-year compound.
      level *= Math.max(0, Math.min(2.5, ratio));
      total += level;
    }

    if (!known) continue;
    totals.push(total);
    finals.push(level);
  }

  if (totals.length < iterations / 4) return null;

  totals.sort((a, b) => a - b);
  const at = (q: number): number => totals[Math.min(totals.length - 1, Math.floor(q * totals.length))]!;

  return {
    median: at(0.5),
    p10: at(0.1),
    p25: at(0.25),
    p75: at(0.75),
    p90: at(0.9),
    // "Still a starter" in the loosest sense: at least half of today.
    survivalOdds: finals.filter((f) => f >= 0.5).length / finals.length,
    years,
  };
};
