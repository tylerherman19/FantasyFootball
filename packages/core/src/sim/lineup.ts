import { SLOT_ELIGIBILITY, type LineupSlot, type PlayerId, type Position } from '../domain/index.js';

/**
 * Optimal lineup selection.
 *
 * Greedy assignment — walk players best-first, drop each into the first slot it
 * fits — is wrong, and wrong in a way that quietly costs points. Consider a
 * SuperFlex league where your best remaining player is a QB: greedy puts him in
 * SUPER_FLEX, and then your second QB has nowhere to go. The optimal answer
 * puts the second QB in SUPER_FLEX and the first in QB.
 *
 * This is an assignment problem, so it gets an assignment algorithm: maximum
 * bipartite matching with augmenting paths, players on one side, starting slots
 * on the other. Players are considered in descending projection order, and each
 * one is admitted only if it can be seated without displacing a better player —
 * which yields the maximum-weight matching for this structure, because
 * eligibility is nested rather than arbitrary.
 */

export interface LineupCandidate {
  readonly playerId: PlayerId;
  readonly position: Position;
  /** Positions the player qualifies at. Sleeper allows multi-position players. */
  readonly eligiblePositions: readonly Position[];
  readonly projectedPoints: number;
  readonly stddev: number;
}

export interface FilledSlot {
  readonly slot: LineupSlot;
  readonly slotIndex: number;
  readonly playerId: PlayerId | null;
  readonly position: Position | null;
  readonly projectedPoints: number;
  readonly stddev: number;
}

export interface OptimalLineup {
  readonly slots: readonly FilledSlot[];
  readonly totalProjected: number;
  /** Players who didn't make the lineup, best first. */
  readonly bench: readonly LineupCandidate[];
}

const canFill = (candidate: LineupCandidate, slot: LineupSlot): boolean => {
  const eligible = SLOT_ELIGIBILITY[slot];
  if (eligible === null) return false;
  if (eligible.includes(candidate.position)) return true;
  return candidate.eligiblePositions.some((p) => eligible.includes(p));
};

/**
 * Try to seat `candidateIndex`, displacing already-seated players only when they
 * can move somewhere else. Standard Kuhn's algorithm augmenting path.
 */
const seat = (
  candidateIndex: number,
  candidates: readonly LineupCandidate[],
  slots: readonly { slot: LineupSlot; index: number }[],
  seatedBy: (number | null)[],
  visited: boolean[],
): boolean => {
  for (let s = 0; s < slots.length; s += 1) {
    if (visited[s] === true) continue;
    if (!canFill(candidates[candidateIndex]!, slots[s]!.slot)) continue;

    visited[s] = true;
    const current = seatedBy[s];

    if (current === null || current === undefined || seat(current, candidates, slots, seatedBy, visited)) {
      seatedBy[s] = candidateIndex;
      return true;
    }
  }
  return false;
};

/**
 * Best legal starting lineup from a roster.
 *
 * `rosterSlots` is the league's full slot list including bench slots; only
 * starting slots are filled, and their original indices are preserved so the
 * caller can render them in league order.
 */
export const optimalLineup = (
  candidates: readonly LineupCandidate[],
  rosterSlots: readonly LineupSlot[],
): OptimalLineup => {
  const startingSlots = rosterSlots
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => SLOT_ELIGIBILITY[slot] !== null);

  const ranked = [...candidates].sort((a, b) => b.projectedPoints - a.projectedPoints);
  const seatedBy: (number | null)[] = Array(startingSlots.length).fill(null);

  for (let i = 0; i < ranked.length; i += 1) {
    seat(i, ranked, startingSlots, seatedBy, Array(startingSlots.length).fill(false));
  }

  const started = new Set<number>();
  const slots: FilledSlot[] = startingSlots.map(({ slot, index }, s) => {
    const candidateIndex = seatedBy[s];

    if (candidateIndex === null || candidateIndex === undefined) {
      return { slot, slotIndex: index, playerId: null, position: null, projectedPoints: 0, stddev: 0 };
    }

    started.add(candidateIndex);
    const candidate = ranked[candidateIndex]!;
    return {
      slot,
      slotIndex: index,
      playerId: candidate.playerId,
      position: candidate.position,
      projectedPoints: candidate.projectedPoints,
      stddev: candidate.stddev,
    };
  });

  return {
    slots: slots.sort((a, b) => a.slotIndex - b.slotIndex),
    totalProjected: slots.reduce((sum, s) => sum + s.projectedPoints, 0),
    bench: ranked.filter((_, i) => !started.has(i)),
  };
};

/**
 * How efficiently a manager actually set their lineup: points scored divided by
 * the points the optimal lineup would have scored, given what everyone did.
 *
 * Simulating every manager as perfect — which is what most tools do implicitly —
 * systematically overrates teams with deep benches they never start.
 */
export const lineupEfficiency = (actualPoints: number, optimalPoints: number): number =>
  optimalPoints <= 0 ? 1 : Math.min(1, actualPoints / optimalPoints);
