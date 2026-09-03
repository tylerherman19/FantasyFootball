import { describe, expect, it } from 'vitest';
import { asPlayerId, type Position } from '../domain/index.js';
import {
  edgePickChart,
  edgePickValues,
  edgeValues,
  multiYearMultiplier,
  replacementLevels,
  starterDemand,
  type AgeCurveData,
  type EdgeValuePlayer,
} from './edge-value.js';

const player = (
  id: string,
  position: Position,
  weeklyPoints: number,
  extra: Partial<EdgeValuePlayer> = {},
): EdgeValuePlayer => ({
  playerId: asPlayerId(id),
  position,
  weeklyPoints,
  gamesRemaining: 17,
  ...extra,
});

describe('starterDemand', () => {
  it('counts dedicated slots in full', () => {
    const demand = starterDemand(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'], 12);
    expect(demand.QB).toBe(12);
    expect(demand.RB).toBe(24);
    expect(demand.WR).toBe(36);
    expect(demand.TE).toBe(12);
  });

  it('splits a flex in proportion to dedicated starters', () => {
    // 2 RB / 3 WR + 1 FLEX in a 12-team league. FLEX is RB/WR/TE-eligible;
    // TE has no dedicated slot so it enters at the 0.5 floor, and the split
    // runs 2 : 3 : 0.5.
    const demand = starterDemand(['RB', 'RB', 'WR', 'WR', 'WR', 'FLEX'], 12);
    expect(demand.RB).toBeCloseTo(24 + 12 * (2 / 5.5), 6);
    expect(demand.WR).toBeCloseTo(36 + 12 * (3 / 5.5), 6);
    expect(demand.TE).toBeCloseTo(12 * (0.5 / 5.5), 6);
  });

  it('treats a superflex slot as a quarterback slot', () => {
    const demand = starterDemand(['QB', 'SUPER_FLEX', 'RB', 'RB', 'WR', 'WR'], 10);
    expect(demand.QB).toBe(20);
  });
});

describe('replacementLevels', () => {
  it('reads the best non-starter off the pool', () => {
    // 2 starting RB slots league-wide; the 3rd-best back sets the level.
    const pool = [player('a', 'RB', 20), player('b', 'RB', 15), player('c', 'RB', 10), player('d', 'RB', 5)];
    const levels = replacementLevels(pool, { RB: 2 });
    expect(levels.RB).toBe(10);
  });

  it('clamps to the pool when slots outnumber players', () => {
    const pool = [player('a', 'K', 8), player('b', 'K', 7)];
    const levels = replacementLevels(pool, { K: 12 });
    expect(levels.K).toBe(7);
  });
});

describe('edgeValues', () => {
  const ctx = {
    dynasty: false,
    startersByPosition: { RB: 2 },
    teamCount: 12,
  };

  it('prices points above replacement, floored at zero', () => {
    const pool = [player('a', 'RB', 20), player('b', 'RB', 15), player('c', 'RB', 10), player('d', 'RB', 5)];
    const values = edgeValues(pool, ctx);
    // Replacement = 10 (3rd of 4 with 2 slots). PAR: 10, 5, 0, 0.
    expect(values.get(asPlayerId('a'))!.weeklyPar).toBe(10);
    expect(values.get(asPlayerId('b'))!.weeklyPar).toBe(5);
    expect(values.get(asPlayerId('c'))!.weeklyPar).toBe(0);
    expect(values.get(asPlayerId('d'))!.weeklyPar).toBe(0);
    // Zero is a statement ("freely available"), not a gap: the player is priced.
    expect(values.get(asPlayerId('d'))!.value).toBe(0);
    expect(values.get(asPlayerId('d'))!.overallRank).toBeGreaterThan(0);
  });

  it('redraft value is PAR times games remaining', () => {
    const pool = [player('a', 'RB', 20, { gamesRemaining: 8 }), player('b', 'RB', 10), player('c', 'RB', 10)];
    const values = edgeValues(pool, ctx);
    expect(values.get(asPlayerId('a'))!.value).toBe(80); // (20-10) * 8
  });

  it('dynasty value annualizes and walks the age curve', () => {
    const curves: AgeCurveData = { curves: { RB: { '24': 1, '25': 0.9, '26': 0.8, '27': 0.6 } } };
    const pool = [player('a', 'RB', 20, { age: 24 }), player('b', 'RB', 10, { age: 24 }), player('c', 'RB', 10, { age: 24 })];
    const values = edgeValues(pool, {
      dynasty: true,
      startersByPosition: { RB: 2 },
      teamCount: 12,
      horizonYears: 4,
      gamesPerSeason: 17,
      ageCurves: curves,
    });
    // PAR 10 * 17 games * (1 + 0.9 + 0.8 + 0.6) = 10 * 17 * 3.3 = 561
    expect(values.get(asPlayerId('a'))!.value).toBeCloseTo(561, 6);
    expect(values.get(asPlayerId('a'))!.multiYear).toBeCloseTo(3.3, 6);
  });

  it('holds years the curve cannot reach flat rather than inventing decline', () => {
    const curves: AgeCurveData = { curves: { RB: { '24': 1, '25': 0.9 } } };
    // Curve stops at 25: years 26 and 27 are held at the last measured share.
    const mult = multiYearMultiplier(curves, 'RB', 24, 4);
    expect(mult).toBeCloseTo(1 + 0.9 + 0.9 + 0.9, 6);
  });

  it('without an age or a curve, the horizon multiplies flat', () => {
    expect(multiYearMultiplier(null, 'RB', 24, 4)).toBe(4);
    expect(multiYearMultiplier({ curves: {} }, 'K', 30, 4)).toBe(4);
    expect(multiYearMultiplier({ curves: { RB: { '24': 1 } } }, 'RB', undefined, 4)).toBe(4);
  });
});

describe('edgePickChart', () => {
  it('refuses to price a class with too little evidence', () => {
    expect(edgePickChart([{ draftOverall: 1, dynastyValue: 500 }])).toBeNull();
  });

  it('prices early slots above late slots, monotonically', () => {
    // A synthetic power-law class: value = 1000 / slot.
    const rookies = Array.from({ length: 48 }, (_, i) => ({
      draftOverall: i + 1,
      dynastyValue: 1000 / (i + 1),
    }));
    const chart = edgePickChart(rookies)!;
    expect(chart).not.toBeNull();
    expect(chart.valueAtSlot(1)).toBeCloseTo(1000, 0);
    expect(chart.valueAtSlot(1)).toBeGreaterThan(chart.valueAtSlot(12));
    expect(chart.valueAtSlot(12)).toBeGreaterThan(chart.valueAtSlot(36));
  });

  it('prices exact slots and tiers on the same curve', () => {
    const rookies = Array.from({ length: 48 }, (_, i) => ({
      draftOverall: i + 1,
      dynastyValue: 1000 / (i + 1),
    }));
    const source = edgePickValues(edgePickChart(rookies)!, 12);
    // A tier midpoint is exactly the slot at the middle of the tier: "mid" in
    // a 12-team round is pick 1.06, so the two pricing paths must agree.
    expect(source.tier(2027, 1, 'mid')).toBeCloseTo(source.exactSlot(1, 6)!, 6);
    // Adjacent slots price alike: pick 2.01 against 1.12 is within a tenth.
    expect(source.exactSlot(2, 1)! / source.exactSlot(1, 12)!).toBeCloseTo(12 / 13, 2);
    expect(source.exactSlot(1, 1)).toBeGreaterThan(source.tier(2027, 1, 'late')!);
  });
});
