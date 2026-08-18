import type { LineupSlot, PlayerId } from '../domain/index.js';
import { optimalLineup, type LineupCandidate } from '../sim/lineup.js';

/**
 * What each player is actually worth to *this* roster.
 *
 * Counting bodies against slots — "you roster five backs and start two, so you
 * can spare one" — is wrong often enough to be useless. Those five backs might
 * fill both flex spots and the bye-week hole behind them, in which case none is
 * spare. Or three might be unstartable, in which case you have no depth at all
 * despite the count.
 *
 * The honest question is counterfactual: if this player disappeared, how much
 * worse would your best legal lineup be? That number is the player's marginal
 * value, and it answers "who can I trade" directly — because a player whose
 * absence costs nothing is genuinely expendable, whatever the position count
 * says.
 *
 * It also naturally handles the cases the heuristic misses. A backup behind an
 * elite starter shows near-zero marginal value even though he's good, which is
 * exactly why he's the right piece to trade. A mediocre starter at a thin
 * position shows high marginal value even though he's bad, which is exactly why
 * you can't move him without a replacement.
 */

export interface MarginalValue {
  readonly playerId: PlayerId;
  /** Points the optimal lineup loses without this player. */
  readonly marginal: number;
  /** The player's own projection, for comparison. */
  readonly projected: number;
  /** True when this player is in the current optimal lineup. */
  readonly starting: boolean;
  /**
   * Points the next man up would provide — the replacement this roster actually
   * has, not a generic baseline.
   */
  readonly replacedBy: number;
}

export const marginalValues = (
  candidates: readonly LineupCandidate[],
  rosterSlots: readonly LineupSlot[],
): MarginalValue[] => {
  const base = optimalLineup(candidates, rosterSlots);
  const starting = new Set(
    base.slots.map((slot) => slot.playerId).filter((id): id is PlayerId => id !== null),
  );

  return candidates.map((candidate) => {
    const without = optimalLineup(
      candidates.filter((other) => other.playerId !== candidate.playerId),
      rosterSlots,
    );

    const marginal = base.totalProjected - without.totalProjected;

    return {
      playerId: candidate.playerId,
      marginal: Math.max(0, marginal),
      projected: candidate.projectedPoints,
      starting: starting.has(candidate.playerId),
      // What the lineup falls back on: the starter's points minus what is lost.
      replacedBy: Math.max(0, candidate.projectedPoints - marginal),
    };
  });
};

export interface DepthAssessment {
  readonly position: string;
  /** Sum of marginal value at this position — how much the lineup leans on it. */
  readonly totalMarginal: number;
  /** Players who could leave without costing the lineup anything meaningful. */
  readonly expendable: readonly PlayerId[];
  /** Points lost if the best player here were removed — the fragility measure. */
  readonly exposureToTopLoss: number;
  readonly verdict: 'thin' | 'balanced' | 'surplus';
}

/** Below this, losing the player costs less than projection error anyway. */
const EXPENDABLE_THRESHOLD = 1.0;

/**
 * Positional depth, judged by consequences rather than headcount.
 *
 * A position is only "surplus" when it holds players whose departure would cost
 * the lineup nothing — and "thin" when the whole position rests on one player.
 */
export const assessDepth = (
  values: readonly (MarginalValue & { position: string })[],
): DepthAssessment[] => {
  const byPosition = new Map<string, (MarginalValue & { position: string })[]>();
  for (const value of values) {
    const bucket = byPosition.get(value.position) ?? [];
    bucket.push(value);
    byPosition.set(value.position, bucket);
  }

  return [...byPosition.entries()].map(([position, players]) => {
    const sorted = [...players].sort((a, b) => b.marginal - a.marginal);
    const totalMarginal = sorted.reduce((sum, p) => sum + p.marginal, 0);
    const expendable = sorted.filter((p) => p.marginal < EXPENDABLE_THRESHOLD).map((p) => p.playerId);
    const exposureToTopLoss = sorted[0]?.marginal ?? 0;

    // A position with real spare parts has someone whose exit is free *and*
    // isn't carrying the whole lineup on one player.
    const verdict: DepthAssessment['verdict'] =
      expendable.length >= 2 && exposureToTopLoss < totalMarginal * 0.6
        ? 'surplus'
        : exposureToTopLoss > totalMarginal * 0.75 && sorted.length > 1
          ? 'thin'
          : 'balanced';

    return { position, totalMarginal, expendable, exposureToTopLoss, verdict };
  });
};
