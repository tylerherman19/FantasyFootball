import { describe, expect, it } from 'vitest';
import { explain, usageRows } from './explain';
import type { ArtifactPlayer } from './projections';

/**
 * The one property that makes a `Why?` panel worth having: the steps sum to the
 * number they explain.
 *
 * An explanation that merely looks plausible is worse than none — it is
 * confident, legible, and unfalsifiable. These tests are what stop the panel
 * quietly becoming that.
 */

const RULES = { rec: 1, rec_yd: 0.1, rec_td: 6 };

const receiver = (over: Partial<ArtifactPlayer> = {}): ArtifactPlayer => ({
  playerId: 'p1',
  name: 'Test Receiver',
  position: 'WR',
  team: 'CIN',
  stats: { receptions: 6, receiving_yards: 85, receiving_tds: 0.6 },
  sd: 7,
  gameId: 'g1',
  gameLoading: 0.4,
  byeWeek: null,
  active: true,
  basis: 'history',
  why: {
    prior: { receptions: 3, receiving_yards: 35, receiving_tds: 0.25 },
    opportunity: { receptions: 5.5, receiving_yards: 70, receiving_tds: 0.5 },
    observed: { targets: 9.2 },
    effectiveGames: 12.1,
  },
  ...over,
});

describe('explain', () => {
  it('produces steps that sum to the projection', () => {
    const result = explain(receiver(), RULES);
    const summed = result.steps.reduce((total, step) => total + step.value, 0);

    expect(summed).toBeCloseTo(result.total, 6);
  });

  it('attributes volume to opportunity and rate to efficiency', () => {
    const result = explain(receiver(), RULES);
    const [baseline, opportunity, efficiency] = result.steps;

    // prior: 3 + 3.5 + 1.5 = 8.0
    expect(baseline?.value).toBeCloseTo(8, 6);
    // opportunity line: 5.5 + 7 + 3 = 15.5, so the step is +7.5
    expect(opportunity?.value).toBeCloseTo(7.5, 6);
    // final: 6 + 8.5 + 3.6 = 18.1, so efficiency is +2.6
    expect(efficiency?.value).toBeCloseTo(2.6, 6);
  });

  it('scores the decomposition in the league\'s own rules', () => {
    const ppr = explain(receiver(), RULES);
    const halfPpr = explain(receiver(), { ...RULES, rec: 0.5 });

    // Same player, different scoring: both must still reconcile.
    expect(halfPpr.total).toBeLessThan(ppr.total);
    expect(halfPpr.steps.reduce((t, s) => t + s.value, 0)).toBeCloseTo(halfPpr.total, 6);
  });

  it('gives a rookie one bar rather than a false waterfall', () => {
    /*
     * A rookie has no prior line and no opportunity line. Decomposing anyway
     * would put the whole projection in the last bucket and label it
     * "efficiency" — exactly backwards for a number that is entirely draft
     * capital.
     */
    const rookie = explain(
      receiver({ basis: 'rookie-prior', why: { effectiveGames: 0 } }),
      RULES,
    );

    expect(rookie.isPrior).toBe(true);
    expect(rookie.steps).toHaveLength(1);
    expect(rookie.steps[0]?.label).toBe('Draft-capital prior');
    expect(rookie.steps[0]?.value).toBeCloseTo(rookie.total, 6);
  });

  it('caps a rookie\'s confidence and says why', () => {
    const rookie = explain(receiver({ basis: 'rookie-prior', why: { effectiveGames: 0 } }), RULES);

    expect(rookie.confidence).toBeLessThan(0.4);
    expect(rookie.confidenceReasons.join(' ')).toMatch(/draft-capital prior/i);
  });

  it('is more confident about a long record than a short one', () => {
    const seasoned = explain(receiver(), RULES);
    const thin = explain(
      receiver({ why: { ...receiver().why!, effectiveGames: 2 } }),
      RULES,
    );

    expect(seasoned.confidence).toBeGreaterThan(thin.confidence);
    expect(thin.confidenceReasons.join(' ')).toMatch(/recency-weighted games/i);
  });

  it('lowers confidence for an injury designation and names it', () => {
    const healthy = explain(receiver(), RULES);
    const hurt = explain(receiver(), RULES, 'Questionable');

    expect(hurt.confidence).toBeLessThan(healthy.confidence);
    expect(hurt.confidenceReasons.join(' ')).toMatch(/questionable/i);
  });

  it('treats a player with no decomposition as a prior rather than crashing', () => {
    const bare = explain(receiver({ why: undefined, basis: 'history' }), RULES);

    expect(bare.isPrior).toBe(true);
    expect(bare.steps).toHaveLength(1);
  });
});

describe('usageRows', () => {
  it('shows only the usage that applies to the position', () => {
    const rows = usageRows(receiver({ stats: { targets: 9, carries: 0, attempts: 0 } }));

    expect(rows.map((r) => r.label)).toEqual(['Targets']);
  });

  it('pairs the projection with what he has actually been doing', () => {
    const rows = usageRows(receiver({ stats: { targets: 8 } }));

    expect(rows[0]?.projected).toBe(8);
    expect(rows[0]?.observed).toBeCloseTo(9.2, 6);
  });
});

// ---------------------------------------------------------------------------

import { careerPhase, remainingPeakSeasons, shareOfPeak, type AgeCurves } from './age-curves';

/**
 * The aging curve replaces a table of hand-set decline ages. These pin the
 * behaviour that made it worth replacing: a continuous read rather than a step
 * on a birthday, and an honest refusal outside the fitted range.
 */
const CURVES: AgeCurves = {
  generatedAt: '2026-08-21T00:00:00Z',
  caveat: 'floor on decline',
  curves: {
    RB: { '22': 0.95, '23': 1.0, '24': 0.94, '25': 0.82, '26': 0.75 },
    QB: { '23': 0.96, '24': 1.0, '25': 0.96 },
  },
};

describe('age curves', () => {
  it('interpolates between birthdays rather than stepping', () => {
    const at24 = shareOfPeak(CURVES, 'RB', 24)!;
    const at25 = shareOfPeak(CURVES, 'RB', 25)!;
    const half = shareOfPeak(CURVES, 'RB', 24.5)!;

    expect(half).toBeLessThan(at24);
    expect(half).toBeGreaterThan(at25);
    expect(half).toBeCloseTo((at24 + at25) / 2, 6);
  });

  it('clamps outside the fitted range instead of extrapolating', () => {
    // The QB curve stops at 25 because the sample thins. A 34-year-old should
    // get the last thing we measured, not an invented number off the end.
    expect(shareOfPeak(CURVES, 'QB', 34)).toBe(0.96);
    expect(shareOfPeak(CURVES, 'RB', 19)).toBe(0.95);
  });

  it('returns null rather than guessing for an unknown position', () => {
    expect(shareOfPeak(CURVES, 'K', 27)).toBeNull();
    expect(shareOfPeak(null, 'RB', 24)).toBeNull();
    expect(shareOfPeak(CURVES, 'RB', null)).toBeNull();
  });

  it('reads direction off the curve, not off a threshold', () => {
    expect(careerPhase(CURVES, 'RB', 22)).toBe('ascending');
    expect(careerPhase(CURVES, 'RB', 24)).toBe('declining');
  });

  it('totals remaining peak-equivalent seasons', () => {
    const young = remainingPeakSeasons(CURVES, 'RB', 22, 3)!;
    const older = remainingPeakSeasons(CURVES, 'RB', 24, 3)!;

    // 0.95 + 1.00 + 0.94 against 0.94 + 0.82 + 0.75.
    expect(young).toBeCloseTo(2.89, 6);
    expect(older).toBeCloseTo(2.51, 6);
    expect(young).toBeGreaterThan(older);
  });
});
