import type { PlayerId } from '../domain/index.js';
import { oddsDelta, type SimContext } from '../decisions/odds.js';

/**
 * Fragility — how much of your season is riding on how few players.
 *
 * Two rosters with identical title odds are not equally safe. One has its odds
 * spread across eight useful starters; the other is two players and a prayer.
 * The second is a worse team to own, because the injury that ends its season is
 * far more likely to happen, and no ranking based on projected points will ever
 * show you that.
 *
 * Measured the only honest way: remove the player and re-simulate. The drop in
 * championship probability *is* what he is worth to this roster, in the same
 * currency as every other decision in the product. A projected-points share
 * would be cheaper and would quietly lie — it can't see that your third
 * receiver is replaceable from the waiver wire while your quarterback is not.
 */

export interface PlayerDependence {
  readonly playerId: PlayerId;
  /** Title probability lost if this player disappeared. Non-negative. */
  readonly titleAtRisk: number;
  /** Playoff probability lost if this player disappeared. */
  readonly playoffAtRisk: number;
}

export interface Fragility {
  readonly teamId: string;
  readonly titlePct: number;
  /** Per-player dependence, largest first. */
  readonly dependence: readonly PlayerDependence[];
  /**
   * Share of this team's title odds carried by its top `topN` players.
   *
   * Above ~0.6 the roster is a coin flip on one injury report; below ~0.3 it is
   * genuinely deep. Null when the team has no title odds to divide.
   */
  readonly concentration: number | null;
  readonly topN: number;
}

export interface FragilityInput {
  readonly context: SimContext;
  readonly teamId: string;
  /**
   * Players to price. Callers should pass the plausible starters rather than the
   * whole roster — each one costs a full season simulation, and the deep bench
   * is guaranteed to score zero on this metric anyway.
   */
  readonly playerIds: readonly PlayerId[];
  /** How many players the concentration figure sums over. */
  readonly topN?: number;
}

export const fragility = ({ context, teamId, playerIds, topN = 2 }: FragilityInput): Fragility => {
  // One baseline for every removal, so each player is priced against the same
  // reference and the comparisons between them are meaningful.
  const dependence: PlayerDependence[] = [];
  let baseline: { titlePct: number; playoffPct: number; expectedWins: number } | null = null;

  for (const playerId of playerIds) {
    const delta = oddsDelta(
      context,
      [{ teamId, drop: [playerId] }],
      teamId,
      baseline ?? undefined,
    );
    baseline ??= delta.before;

    dependence.push({
      playerId,
      // Losing a player cannot help, and shouldn't be reported as if it could;
      // small negative deltas here are simulation noise, not a real finding.
      titleAtRisk: Math.max(0, -delta.titleDelta),
      playoffAtRisk: Math.max(0, -delta.playoffDelta),
    });
  }

  dependence.sort((a, b) => b.titleAtRisk - a.titleAtRisk);

  const titlePct = baseline?.titlePct ?? 0;
  const atRiskTop = dependence.slice(0, topN).reduce((sum, d) => sum + d.titleAtRisk, 0);

  return {
    teamId,
    titlePct,
    dependence,
    // Capped at one: the individual removals are measured independently, so on a
    // top-heavy roster they can sum past the whole without that meaning
    // anything beyond "all of it".
    concentration: titlePct > 0 ? Math.min(1, atRiskTop / titlePct) : null,
    topN,
  };
};
