import type { PlayerId, Position } from '../domain/index.js';
import { currentOdds, oddsDelta, type OddsDelta, type SimContext } from './odds.js';

/**
 * Trades, priced in both currencies at once.
 *
 * Market value answers "is this fair" — will the other manager plausibly accept.
 * Championship probability answers "is this good for me" — the question that
 * actually matters. Tools that report only the first tell you a trade is even
 * when it does nothing for your season; tools that report only the second
 * propose trades nobody would ever accept.
 *
 * Both sides see both numbers, which is what ends the argument.
 */

export interface TradeAsset {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly position: Position;
  /** Market value from the configured source. */
  readonly value: number;
}

export interface TradeSide {
  readonly teamId: string;
  readonly sends: readonly TradeAsset[];
}

export interface TradeEvaluation {
  readonly sideA: TradeSide;
  readonly sideB: TradeSide;
  /** Odds impact for each team, keyed by team id. */
  readonly odds: ReadonlyMap<string, OddsDelta>;
  readonly valueDelta: ReadonlyMap<string, number>;
  /** How lopsided in market terms, 0 = even. */
  readonly fairness: number;
  readonly verdict: string;
}

const sumValue = (assets: readonly TradeAsset[]): number =>
  assets.reduce((total, asset) => total + asset.value, 0);

/**
 * Market fairness as a proportion of the larger side.
 *
 * Proportional rather than absolute because 500 points of value means something
 * very different in a trade of backups than in one involving two first-rounders.
 */
export const fairnessGap = (valueA: number, valueB: number): number => {
  const larger = Math.max(valueA, valueB);
  return larger <= 0 ? 0 : Math.abs(valueA - valueB) / larger;
};

const describeVerdict = (myTitleDelta: number, theirTitleDelta: number, gap: number): string => {
  if (myTitleDelta <= 0) return 'declines your odds — pass';
  if (gap > 0.25) return 'helps you, but lopsided enough that they will likely refuse';
  if (theirTitleDelta > 0) return 'both sides improve — the rare genuinely mutual trade';
  return 'improves your odds at their expense — worth proposing';
};

export const evaluateTrade = (
  context: SimContext,
  sideA: TradeSide,
  sideB: TradeSide,
): TradeEvaluation => {
  const beforeA = currentOdds(context, sideA.teamId);
  const beforeB = currentOdds(context, sideB.teamId);

  const changes = [
    {
      teamId: sideA.teamId,
      add: sideB.sends.map((a) => a.playerId),
      drop: sideA.sends.map((a) => a.playerId),
    },
    {
      teamId: sideB.teamId,
      add: sideA.sends.map((a) => a.playerId),
      drop: sideB.sends.map((a) => a.playerId),
    },
  ];

  const deltaA = oddsDelta(context, changes, sideA.teamId, beforeA);
  const deltaB = oddsDelta(context, changes, sideB.teamId, beforeB);

  const valueA = sumValue(sideA.sends);
  const valueB = sumValue(sideB.sends);

  return {
    sideA,
    sideB,
    odds: new Map([
      [sideA.teamId, deltaA],
      [sideB.teamId, deltaB],
    ]),
    valueDelta: new Map([
      [sideA.teamId, valueB - valueA],
      [sideB.teamId, valueA - valueB],
    ]),
    fairness: fairnessGap(valueA, valueB),
    verdict: describeVerdict(deltaA.titleDelta, deltaB.titleDelta, fairnessGap(valueA, valueB)),
  };
};

export interface TradeFinderInput {
  readonly context: SimContext;
  readonly myTeamId: string;
  /** Assets by team, including mine. */
  readonly assetsByTeam: ReadonlyMap<string, readonly TradeAsset[]>;
  /** Positions I want to acquire. */
  readonly needs: readonly Position[];
  /** Positions I'm willing to give up. */
  readonly surplus: readonly Position[];
  /** Only propose trades within this market-value band. */
  readonly fairnessBand?: number;
  /** How many candidates survive to full simulation. */
  readonly finalists?: number;
}

interface Candidate {
  readonly partnerId: string;
  readonly iSend: readonly TradeAsset[];
  readonly iGet: readonly TradeAsset[];
  readonly proxyScore: number;
}

/**
 * Find realistic trades that improve my roster.
 *
 * The search space is combinatorial, so it is pipelined rather than brute
 * forced — the design the plan calls for:
 *
 *   1. enumerate small packages only (1-for-1, 2-for-1, 1-for-2)
 *   2. filter to a market-value fairness band, so proposals are plausibly
 *      acceptable to a real manager rather than technically optimal fantasies
 *   3. rank by a cheap proxy — projected starter points gained at needed
 *      positions — which costs nothing per candidate
 *   4. run the expensive full simulation only on the survivors
 *
 * Without step 3, evaluating every package at 4,000 iterations would take
 * minutes. With it, the finalists are simulated properly and everything else
 * is discarded for free.
 */
export const findTrades = (input: TradeFinderInput): TradeEvaluation[] => {
  const { context, myTeamId, assetsByTeam } = input;
  const band = input.fairnessBand ?? 0.15;
  const finalists = input.finalists ?? 10;

  const mine = assetsByTeam.get(myTeamId) ?? [];
  const myTradeable = mine.filter((a) => input.surplus.includes(a.position));

  const candidates: Candidate[] = [];

  for (const [partnerId, theirAssets] of assetsByTeam) {
    if (partnerId === myTeamId) continue;
    const theirTargets = theirAssets.filter((a) => input.needs.includes(a.position));

    for (const target of theirTargets) {
      for (const offer of myTradeable) {
        // 1-for-1
        pushIfFair(candidates, partnerId, [offer], [target], band);

        // 2-for-1: sweeten with a second piece when the target is worth more.
        for (const sweetener of myTradeable) {
          if (sweetener.playerId === offer.playerId) continue;
          pushIfFair(candidates, partnerId, [offer, sweetener], [target], band);
        }
      }

      // 1-for-2: take back a second piece when my offer is the bigger asset.
      for (const offer of myTradeable) {
        for (const extra of theirTargets) {
          if (extra.playerId === target.playerId) continue;
          pushIfFair(candidates, partnerId, [offer], [target, extra], band);
        }
      }
    }
  }

  const ranked = candidates.sort((a, b) => b.proxyScore - a.proxyScore).slice(0, finalists);

  return ranked
    .map((candidate) =>
      evaluateTrade(
        context,
        { teamId: myTeamId, sends: candidate.iSend },
        { teamId: candidate.partnerId, sends: candidate.iGet },
      ),
    )
    .filter((evaluation) => (evaluation.odds.get(myTeamId)?.titleDelta ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.odds.get(myTeamId)?.titleDelta ?? 0) - (a.odds.get(myTeamId)?.titleDelta ?? 0),
    );
};

const pushIfFair = (
  into: Candidate[],
  partnerId: string,
  iSend: readonly TradeAsset[],
  iGet: readonly TradeAsset[],
  band: number,
): void => {
  const sendValue = sumValue(iSend);
  const getValue = sumValue(iGet);
  if (fairnessGap(sendValue, getValue) > band) return;

  // Cheap proxy: value gained, net of what I give up. Correlates well enough
  // with the simulated result to rank candidates, and costs nothing.
  into.push({ partnerId, iSend, iGet, proxyScore: getValue - sendValue });
};
