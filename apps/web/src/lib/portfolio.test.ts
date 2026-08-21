import { describe, expect, it } from 'vitest';
import { analysePortfolio, correlationOf, portfolioRead, type PortfolioPlayer } from './portfolio';

/**
 * The property that makes this worth having: two rosters with identical
 * projected points and identical individual variances must NOT get the same
 * risk number if one of them is stacked. That is the thing a sum-of-values
 * roster table structurally cannot tell you.
 */

const player = (over: Partial<PortfolioPlayer> & { playerId: string }): PortfolioPlayer => ({
  name: over.playerId,
  position: 'WR',
  team: 'CIN',
  mean: 15,
  sd: 7,
  gameId: 'g1',
  gameLoading: 0.4,
  marketValue: 5000,
  ...over,
});

describe('correlationOf', () => {
  it('is the product of game loadings within one game', () => {
    const qb = player({ playerId: 'qb', position: 'QB', gameLoading: 0.45 });
    const wr = player({ playerId: 'wr', gameLoading: 0.4 });

    expect(correlationOf(qb, wr)).toBeCloseTo(0.18, 6);
  });

  it('is zero across different games', () => {
    const a = player({ playerId: 'a', gameId: 'g1' });
    const b = player({ playerId: 'b', gameId: 'g2' });

    expect(correlationOf(a, b)).toBe(0);
  });

  it('is zero when a player has no game — a bye is not a shared environment', () => {
    const a = player({ playerId: 'a', gameId: '' });
    const b = player({ playerId: 'b', gameId: 'g1' });

    expect(correlationOf(a, b)).toBe(0);
  });
});

describe('analysePortfolio', () => {
  it('charges a stacked roster more variance than a spread one', () => {
    const stacked = analysePortfolio([
      player({ playerId: 'a', gameId: 'g1' }),
      player({ playerId: 'b', gameId: 'g1' }),
      player({ playerId: 'c', gameId: 'g1' }),
    ]);
    const spread = analysePortfolio([
      player({ playerId: 'a', gameId: 'g1' }),
      player({ playerId: 'b', gameId: 'g2' }),
      player({ playerId: 'c', gameId: 'g3' }),
    ]);

    // Identical expected points and identical individual spreads.
    expect(stacked.expected).toBe(spread.expected);
    expect(stacked.independentSd).toBeCloseTo(spread.independentSd, 6);

    // But the stacked roster has a genuinely wider weekly range.
    expect(stacked.sd).toBeGreaterThan(spread.sd);
    expect(stacked.correlationPenalty).toBeGreaterThan(1);
    expect(spread.correlationPenalty).toBeCloseTo(1, 6);
  });

  it('reduces to independence when nobody shares a game', () => {
    const analysis = analysePortfolio([
      player({ playerId: 'a', gameId: 'g1' }),
      player({ playerId: 'b', gameId: 'g2' }),
    ]);

    expect(analysis.sd).toBeCloseTo(analysis.independentSd, 6);
  });

  it('measures value concentration by offence', () => {
    const analysis = analysePortfolio([
      player({ playerId: 'a', team: 'CIN', marketValue: 6000 }),
      player({ playerId: 'b', team: 'CIN', marketValue: 2000 }),
      player({ playerId: 'c', team: 'PHI', marketValue: 2000 }),
    ]);

    expect(analysis.byTeam[0]?.label).toBe('CIN');
    expect(analysis.byTeam[0]?.share).toBeCloseTo(0.8, 6);
  });

  it('measures how much rides on the top two assets', () => {
    const analysis = analysePortfolio([
      player({ playerId: 'a', marketValue: 8000 }),
      player({ playerId: 'b', marketValue: 6000 }),
      player({ playerId: 'c', marketValue: 1000 }),
      player({ playerId: 'd', marketValue: 1000 }),
    ]);

    expect(analysis.topTwoShare).toBeCloseTo(14 / 16, 6);
  });

  it('handles an empty roster without dividing by zero', () => {
    const analysis = analysePortfolio([]);

    expect(analysis.expected).toBe(0);
    expect(analysis.correlationPenalty).toBe(1);
    expect(analysis.topTwoShare).toBe(0);
  });
});

describe('portfolioRead', () => {
  it('names stacking when correlation widens the range', () => {
    const stacked = analysePortfolio(
      ['a', 'b', 'c', 'd'].map((id) => player({ playerId: id, gameId: 'g1', gameLoading: 0.6 })),
    );

    expect(portfolioRead(stacked)).toMatch(/stacked/i);
  });

  it('names single-offence exposure', () => {
    const analysis = analysePortfolio([
      player({ playerId: 'a', team: 'CIN', gameId: 'g1', marketValue: 9000 }),
      player({ playerId: 'b', team: 'PHI', gameId: 'g2', marketValue: 1000 }),
    ]);

    expect(portfolioRead(analysis)).toMatch(/one offence \(CIN\)/);
  });

  it('credits a fully spread roster rather than staying silent', () => {
    // Independent games, even value: the useful thing to say is that the bad
    // weeks arrive separately, not that there is nothing to report.
    const analysis = analysePortfolio(
      ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
        player({ playerId: id, team: `T${i}`, gameId: `g${i}`, marketValue: 2000 }),
      ),
    );

    const read = portfolioRead(analysis);
    expect(read).toMatch(/spread across games/i);
    expect(read).not.toMatch(/stacked/i);
  });

  it('falls back to plain language when nothing crosses a threshold', () => {
    // Mild shared exposure: past the "spread" threshold, short of "stacked".
    const analysis = analysePortfolio([
      player({ playerId: 'a', team: 'CIN', gameId: 'g1', gameLoading: 0.45, marketValue: 2000 }),
      player({ playerId: 'b', team: 'PHI', gameId: 'g1', gameLoading: 0.45, marketValue: 2000 }),
      player({ playerId: 'c', team: 'KC', gameId: 'g2', gameLoading: 0.3, marketValue: 2000 }),
      player({ playerId: 'd', team: 'BUF', gameId: 'g3', gameLoading: 0.3, marketValue: 2000 }),
      player({ playerId: 'e', team: 'LA', gameId: 'g4', gameLoading: 0.3, marketValue: 2000 }),
      player({ playerId: 'f', team: 'DAL', gameId: 'g5', gameLoading: 0.3, marketValue: 2000 }),
    ]);

    // Between the two thresholds: neither notably stacked nor notably spread.
    expect(analysis.correlationPenalty).toBeGreaterThan(1.02);
    expect(analysis.correlationPenalty).toBeLessThan(1.06);
    expect(portfolioRead(analysis)).toMatch(/No concentration worth flagging/i);
  });
});

// ---------------------------------------------------------------------------

import { simulateMultiYearValue, type AgeCurves as Curves } from './age-curves';

/**
 * §20 asks for dynasty value *with uncertainty*. These pin the two things that
 * make the distribution worth having over a point estimate.
 */
const WITH_SPREAD: Curves = {
  generatedAt: '2026-08-21T00:00:00Z',
  caveat: '',
  curves: { RB: { '24': 0.94, '25': 0.82, '26': 0.75, '27': 0.7 } },
  transitions: [
    { position: 'RB', from_age: 24, ratio: 0.88, pairs: 112, ratio_sd: 0.4, ratio_se: 0.05 },
    { position: 'RB', from_age: 25, ratio: 0.91, pairs: 94, ratio_sd: 0.45, ratio_se: 0.06 },
    { position: 'RB', from_age: 26, ratio: 0.93, pairs: 88, ratio_sd: 0.42, ratio_se: 0.06 },
  ],
};

describe('simulateMultiYearValue', () => {
  it('produces a spread, not a point', () => {
    const d = simulateMultiYearValue(WITH_SPREAD, 'RB', 24, 3)!;

    expect(d.p90).toBeGreaterThan(d.median);
    expect(d.median).toBeGreaterThan(d.p10);
    // Aging spread for backs is large; the interval should be visibly wide.
    expect(d.p90 - d.p10).toBeGreaterThan(0.5);
  });

  it('is deterministic, so a number does not change on refresh', () => {
    const a = simulateMultiYearValue(WITH_SPREAD, 'RB', 24, 3);
    const b = simulateMultiYearValue(WITH_SPREAD, 'RB', 24, 3);

    expect(a).toEqual(b);
  });

  it('reports survival odds as a probability', () => {
    const d = simulateMultiYearValue(WITH_SPREAD, 'RB', 24, 3)!;

    expect(d.survivalOdds).toBeGreaterThanOrEqual(0);
    expect(d.survivalOdds).toBeLessThanOrEqual(1);
  });

  it('declines to answer past the fitted range rather than extrapolating', () => {
    // Transitions stop at 26, so a four-year horizon from 24 cannot complete.
    expect(simulateMultiYearValue(WITH_SPREAD, 'RB', 24, 6)).toBeNull();
    expect(simulateMultiYearValue(WITH_SPREAD, 'QB', 24, 2)).toBeNull();
    expect(simulateMultiYearValue(null, 'RB', 24, 2)).toBeNull();
  });

  it('never lets a season go negative', () => {
    // ratio_sd of 0.4 on a median of 0.88 means draws below zero are common,
    // and a negative season would corrupt every year that compounds after it.
    const d = simulateMultiYearValue(WITH_SPREAD, 'RB', 24, 3)!;

    expect(d.p10).toBeGreaterThanOrEqual(1);
  });
});
