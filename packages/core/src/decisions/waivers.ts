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
  /**
   * Value expected from future weeks' claims, overriding the estimate derived
   * from this candidate list.
   *
   * Needed because bids must not depend on how many candidates were simulated.
   * A two-stage screen that hands the finalist round three players would
   * otherwise conclude the wire is barren and bid the whole budget.
   */
  readonly expectedFutureGain?: number;
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
 * What a typical future week's best claim is likely to be worth.
 *
 * Estimated from an observed field rather than assumed, using the *second* best
 * option as the stand-in for "what turns up next week" — the best one is the
 * outlier we're pricing against, so using it would make every week look like
 * this one.
 */
export const estimateFutureGain = (
  titleDeltas: readonly number[],
  weeksRemaining: number,
): number => {
  const positive = titleDeltas.filter((d) => d > 0).sort((a, b) => b - a);
  if (positive.length === 0) return 0;

  // Median of the runners-up, not the second-best value itself. A single noisy
  // screening estimate should not move a bid recommendation by tens of dollars,
  // and a manager who sees $43 one refresh and $8 the next stops believing any
  // of it. The best option is excluded because it is the outlier being priced.
  const runnersUp = positive.slice(1, 6);
  const typicalOpportunity =
    runnersUp.length > 0 ? runnersUp[Math.floor(runnersUp.length / 2)]! : positive[0]! * 0.5;

  // Crucially, *not* one useful add per remaining week. Multiplying by the full
  // schedule assumes a season-changing free agent appears every Tuesday, which
  // makes even a genuinely valuable claim look worthless by comparison and
  // recommends absurdly small bids. In practice a season yields a handful of
  // adds that move a roster at all, so the horizon is capped.
  const realisticOpportunities = Math.min(Math.max(0, weeksRemaining - 1), MAX_MEANINGFUL_CLAIMS);

  return typicalOpportunity * realisticOpportunities;
};

/**
 * How many genuinely useful free agents a season realistically offers after
 * this one. Waiver wires are front-loaded — most value appears in the first few
 * weeks as injuries reshuffle roles — and thin out from there.
 */
const MAX_MEANINGFUL_CLAIMS = 4;

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
  const expectedFutureGain =
    input.expectedFutureGain ?? typicalWeeklyGain * Math.max(0, input.weeksRemaining - 1);

  return evaluated
    .map(({ candidate, delta, dropPlayerId }) => {
      const { bid, rationale } = suggestBid(delta.titleDelta, input.remainingBudget, expectedFutureGain);
      return { candidate, delta, dropPlayerId, suggestedBid: bid, bidRationale: rationale };
    })
    .sort((a, b) => b.delta.titleDelta - a.delta.titleDelta);
};
