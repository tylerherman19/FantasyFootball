import { describe, expect, it } from 'vitest';
import { asPlayerId, type LineupSlot, type Position } from '../domain/index.js';
import { assessDepth, isExpendable, marginalValues } from './marginal-value.js';
import type { LineupCandidate } from '../sim/lineup.js';

const player = (id: string, position: Position, projectedPoints: number): LineupCandidate => ({
  playerId: asPlayerId(id),
  position,
  eligiblePositions: [position],
  projectedPoints,
  stddev: 4,
});

describe('marginal roster value', () => {
  it('does not classify a current starter as expendable when a duplicate slot makes marginal value small', () => {
    const slots: LineupSlot[] = ['WR', 'FLEX', 'BN'];
    const values = marginalValues(
      [player('wr1', 'WR', 24), player('wr2', 'WR', 23), player('wr3', 'WR', 4)],
      slots,
    );
    const wr1 = values.find((value) => value.playerId === asPlayerId('wr1'))!;

    expect(wr1.starting).toBe(true);
    expect(isExpendable(wr1)).toBe(false);
    expect(assessDepth(values.map((value) => ({ ...value, position: 'WR' as Position })))[0]?.expendable)
      .not.toContain(asPlayerId('wr1'));
  });

  it('classifies a non-starting player with a genuine replacement as expendable', () => {
    const slots: LineupSlot[] = ['WR', 'BN'];
    const values = marginalValues(
      [player('starter', 'WR', 20), player('bench', 'WR', 8)],
      slots,
    );
    const bench = values.find((value) => value.playerId === asPlayerId('bench'))!;

    expect(bench.starting).toBe(false);
    expect(isExpendable(bench)).toBe(true);
  });
});
