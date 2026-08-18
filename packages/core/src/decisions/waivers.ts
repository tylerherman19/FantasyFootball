import type { PlayerId } from '../domain/index.js';
import { currentOdds, oddsDelta, type OddsDelta, type SimContext } from './odds.js';

/**
 * Waiver wire, priced in championship probability.
 *
 * The usual approach ranks free agents by projected points, which answers the
 * wrong question. A backup running back is worth a lot to the manager whose
 * starter just tore an ACL and nothing at all to everyone else — same player,
 * same projection, wildly different value. Simulating your specific roster with
 * and without him is the only way to see that.
 *
 * The bid follows from the same number.
 */

export interface WaiverCandidate {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly position: string;
  /** Percentage of leagues rostering this player, when known. */
  readonly rosteredPct?: number;
}

export interface WaiverRecommendation {
  readonly candidate: WaiverCandidate;
  readonly delta: OddsDelta;
  /** Player who would be dropped to make room, if the roster is full. */
  readonly dropPlayerId: PlayerId | null;
  readonly suggestedBid: number;
  readonly bidRationale: string;
}

export interface WaiverInput {
  readonly context: SimContext;
  readonly teamId: string;
  readonly candidates: readonly WaiverCandidate[];
  /** Droppable players, worst first. Empty means the roster has open spots. */
  readonly dropCandidates: readonly PlayerId[];
  readonly remainingBudget: number;
  /** Weeks left in the regular season, used to price future opportunities. */
  readonly weeksRemaining: number;
}

/**
 * Bid sizing, Kelly-flavoured.
 *
 * True Kelly sizes a bet by edge over odds against a known payoff. FAAB isn't
 * quite that — the budget is a season-long allocation problem, not a single
 * wager — so the same logic is applied to the allocation instead: spend a share
 * of the remaining budget proportional to this claim's share of the total value
 * you still expect to capture.
 *
 *   bid = budget x gain / (gain + expected future gains)
 *
 * The practical consequences are the ones that matter. A player who moves your
 * title odds 4% when nothing else on the wire moves them at all is worth an
 * enormous share of your budget — and the formula says so, where "spend 20% on
 * the top guy" heuristics do not. A marginal streamer in week 12, with little
 * season left to exploit him, prices near zero.
 */
export const suggestBid = (
  gain: number,
  remainingBudget: number,
  expectedFutureGain: number,
): { bid: number; rationale: string } => {
  if (gain <= 0 || remainingBudget <= 0) {
    return { bid: 0, rationale: 'no measurable gain — do not bid' };
  }

  const share = gain / (gain + Math.max(expectedFutureGain, 1e-9));
  const bid = Math.max(1, Math.round(remainingBudget * share));

  const rationale =
    share > 0.5
      ? `worth ${(share * 100).toFixed(0)}% of remaining budget — little else on the wire compares`
      : `worth ${(share * 100).toFixed(0)}% of remaining budget against what's still likely to come`;

  return { bid: Math.min(bid, remainingBudget), rationale };
};

/**
 * Rank the wire for one specific roster.
 *
 * Each candidate is evaluated paired with the drop that costs least, since on a
 * full roster adding is inseparable from cutting — and a claim that forces you
 * to drop someone valuable can easily be negative.
 */
export const rankWaivers = (input: WaiverInput): WaiverRecommendation[] => {
  const { context, teamId, candidates, dropCandidates } = input;

  const before = currentOdds(context, teamId);

  const evaluated = candidates.map((candidate) => {
    let best: { delta: OddsDelta; dropPlayerId: PlayerId | null } | null = null;

    // With an open roster spot, no drop is needed. Otherwise try each droppable
    // player and keep the pairing that helps most.
    const dropOptions: (PlayerId | null)[] = dropCandidates.length > 0 ? [...dropCandidates] : [null];

    for (const dropPlayerId of dropOptions) {
      const delta = oddsDelta(
        context,
        [
          {
            teamId,
            add: [candidate.playerId],
            ...(dropPlayerId !== null ? { drop: [dropPlayerId] } : {}),
          },
        ],
        teamId,
        before,
      );

      if (best === null || delta.titleDelta > best.delta.titleDelta) {
        best = { delta, dropPlayerId };
      }
    }

    return { candidate, ...best! };
  });

  // Future opportunity: what a typical remaining week's best claim is worth.
  // Estimated from this week's field rather than assumed, then scaled by the
  // weeks left to exploit it.
  const positiveGains = evaluated.map((e) => e.delta.titleDelta).filter((d) => d > 0).sort((a, b) => b - a);
  const typicalWeeklyGain = positiveGains.length > 1 ? positiveGains[1]! : (positiveGains[0] ?? 0) * 0.5;
  const expectedFutureGain = typicalWeeklyGain * Math.max(0, input.weeksRemaining - 1);

  return evaluated
    .map(({ candidate, delta, dropPlayerId }) => {
      const { bid, rationale } = suggestBid(delta.titleDelta, input.remainingBudget, expectedFutureGain);
      return { candidate, delta, dropPlayerId, suggestedBid: bid, bidRationale: rationale };
    })
    .sort((a, b) => b.delta.titleDelta - a.delta.titleDelta);
};
