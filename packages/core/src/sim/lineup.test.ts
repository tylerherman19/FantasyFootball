import { describe, expect, it } from 'vitest';
import { asPlayerId, type LineupSlot, type Position } from '../domain/index.js';
import { optimalLineup, type LineupCandidate } from './lineup.js';

const player = (
  id: string,
  position: Position,
  projectedPoints: number,
  eligiblePositions: readonly Position[] = [position],
): LineupCandidate => ({
  playerId: asPlayerId(id),
  position,
  eligiblePositions,
  projectedPoints,
  stddev: 5,
});

describe('optimalLineup', () => {
  it('fills simple slots best-first', () => {
    const slots: LineupSlot[] = ['QB', 'RB', 'BN'];
    const result = optimalLineup(
      [player('qb1', 'QB', 20), player('rb1', 'RB', 15), player('rb2', 'RB', 9)],
      slots,
    );

    expect(result.slots.map((s) => s.playerId)).toEqual([asPlayerId('qb1'), asPlayerId('rb1')]);
    expect(result.totalProjected).toBe(35);
    expect(result.bench.map((b) => b.playerId)).toEqual([asPlayerId('rb2')]);
  });

  /**
   * The case greedy gets wrong. Best-first assignment drops the top QB into
   * SUPER_FLEX (it's eligible and comes first), stranding the second QB with
   * nowhere to sit and leaving the dedicated QB slot for someone worse.
   *
   * Correct answer starts both quarterbacks: 25 + 22 + 14 = 61.
   * Greedy would produce 25 in SUPER_FLEX, 14 in QB... and bench a 22.
   */
  it('starts both quarterbacks in superflex rather than stranding one', () => {
    const slots: LineupSlot[] = ['QB', 'RB', 'SUPER_FLEX', 'BN'];
    const result = optimalLineup(
      [player('qb1', 'QB', 25), player('qb2', 'QB', 22), player('rb1', 'RB', 14)],
      slots,
    );

    const startedIds = result.slots.map((s) => s.playerId);
    expect(startedIds).toContain(asPlayerId('qb1'));
    expect(startedIds).toContain(asPlayerId('qb2'));
    expect(result.totalProjected).toBe(61);
    expect(result.bench).toHaveLength(0);
  });

  it('prefers the higher scorer when only one flex seat exists', () => {
    const slots: LineupSlot[] = ['RB', 'FLEX', 'BN'];
    const result = optimalLineup(
      [player('rb1', 'RB', 18), player('wr1', 'WR', 16), player('te1', 'TE', 4)],
      slots,
    );

    expect(result.totalProjected).toBe(34);
    expect(result.bench.map((b) => b.playerId)).toEqual([asPlayerId('te1')]);
  });

  it('respects multi-position eligibility', () => {
    // A player listed at both RB and WR can fill the receiver-only flex.
    const slots: LineupSlot[] = ['REC_FLEX', 'BN'];
    const result = optimalLineup([player('hybrid', 'RB', 12, ['RB', 'WR'])], slots);

    expect(result.slots[0]?.playerId).toBe(asPlayerId('hybrid'));
  });

  it('leaves a slot empty rather than starting an ineligible player', () => {
    const slots: LineupSlot[] = ['QB', 'K'];
    const result = optimalLineup([player('qb1', 'QB', 20)], slots);

    expect(result.slots[1]?.playerId).toBeNull();
    expect(result.slots[1]?.projectedPoints).toBe(0);
    expect(result.totalProjected).toBe(20);
  });

  it('ignores bench, IR and taxi slots', () => {
    const slots: LineupSlot[] = ['QB', 'BN', 'IR', 'TAXI'];
    const result = optimalLineup([player('qb1', 'QB', 20), player('qb2', 'QB', 18)], slots);

    expect(result.slots).toHaveLength(1);
    expect(result.bench.map((b) => b.playerId)).toEqual([asPlayerId('qb2')]);
  });

  it('preserves league slot order in the output', () => {
    const slots: LineupSlot[] = ['RB', 'QB', 'BN', 'WR'];
    const result = optimalLineup(
      [player('qb1', 'QB', 20), player('rb1', 'RB', 15), player('wr1', 'WR', 10)],
      slots,
    );

    expect(result.slots.map((s) => s.slot)).toEqual(['RB', 'QB', 'WR']);
  });
});
