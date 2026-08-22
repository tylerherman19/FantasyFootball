import { describe, expect, it } from 'vitest';
import { distributionOf } from './distribution';

describe('distributionOf', () => {
  it('produces an ordered percentile ladder', () => {
    const d = distributionOf(15, 6);
    const values = d.percentiles.map((p) => p.value);

    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(d.percentiles[2]!.label).toBe('Median');
  });

  it('centres the median on the projection when nothing is clamped', () => {
    const d = distributionOf(20, 5);
    expect(d.percentiles[2]!.value).toBeCloseTo(20, 4);
  });

  it('never quotes a negative week', () => {
    // A 4.0 projection with a spread of 6 has a Gaussian 10th percentile below
    // zero. That is an artefact of the approximation, not a possible outcome.
    const d = distributionOf(4, 6);

    expect(d.percentiles.every((p) => p.value >= 0)).toBe(true);
    expect(d.truncated).toBe(true);
  });

  it('does not claim truncation when none happened', () => {
    expect(distributionOf(25, 5).truncated).toBe(false);
  });

  it('matches the normal at known z values', () => {
    const d = distributionOf(0, 1);
    // 10th and 90th percentiles of a standard normal.
    expect(d.percentiles[4]!.value).toBeCloseTo(1.2816, 3);
  });

  it('gives threshold odds that fall as the bar rises', () => {
    const d = distributionOf(18, 7);
    const p = d.thresholds.map((t) => t.probability);

    expect(p[0]!).toBeGreaterThan(p[1]!);
    expect(p[1]!).toBeGreaterThan(p[2]!);
    expect(p.every((x) => x >= 0 && x <= 1)).toBe(true);
  });

  it('picks thresholds that carry information at both ends of the scale', () => {
    // Fixed 20/25/30 is "about zero" three times for a 6-point projection and
    // "yes" three times for a 25-point one.
    const low = distributionOf(6, 4).thresholds.map((t) => t.threshold);
    const high = distributionOf(24, 8).thresholds.map((t) => t.threshold);

    expect(low[0]!).toBeLessThan(high[0]!);
    expect(low.every((t) => t > 6)).toBe(true);
    expect(high.every((t) => t > 24)).toBe(true);
  });

  it('survives a zero spread without dividing by it', () => {
    const d = distributionOf(10, 0);
    expect(Number.isFinite(d.percentiles[0]!.value)).toBe(true);
    expect(d.thresholds.every((t) => Number.isFinite(t.probability))).toBe(true);
  });
});
