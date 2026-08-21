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

export interface AgeCurves {
  readonly generatedAt: string;
  readonly caveat: string;
  /** position -> age (as string) -> share of that position's peak production. */
  readonly curves: Readonly<Record<string, Readonly<Record<string, number>>>>;
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
