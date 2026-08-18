/**
 * Seeded randomness.
 *
 * Every simulation must be reproducible: the same league on the same day gives
 * the same odds. Without that, a user who refreshes sees their title chances
 * wobble by a point and rightly stops trusting the number.
 *
 * SplitMix32 — fast, small state, good distribution at the scale we need
 * (10k iterations x ~200 player-weeks).
 */
export type Rng = () => number;

export const seededRng = (seed: number): Rng => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
};

/** Deterministic seed from arbitrary identifiers, so each league is independent. */
export const seedFrom = (...parts: (string | number)[]): number => {
  let hash = 2166136261;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
};

/** Standard normal via Box-Muller. */
export const standardNormal = (rng: Rng): number => {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

/**
 * Sample from an empirical distribution of residuals.
 *
 * Fantasy scores are right-skewed — many ordinary weeks, occasional enormous
 * ones — and a normal curve simply cannot produce that shape. Rather than model
 * the skew, we resample real historical residuals, which carries the true shape
 * including its fat tail for free.
 */
export const resample = (residuals: readonly number[], rng: Rng): number => {
  if (residuals.length === 0) return standardNormal(rng);
  return residuals[Math.floor(rng() * residuals.length)]!;
};
