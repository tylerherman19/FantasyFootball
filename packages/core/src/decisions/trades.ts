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
  /**
   * What the manager is trying to do, which changes what "a good trade" means.
   *
   * A contender and a rebuilding team can look at the same package and both be
   * right to disagree: one is buying this season's points, the other is buying
   * assets that are still assets in two years. Ranking both on one number tells
   * one of them the wrong thing.
   */
  readonly objective?: TradeObjective;
  /** Only propose packages that acquire one of these players. */
  readonly targetPlayerIds?: readonly PlayerId[];
  /** Only propose packages that acquire one of these positions. */
  readonly targetPositions?: readonly Position[];
  /** Player ages, for objectives that care. Unknown ages count as prime. */
  readonly ages?: ReadonlyMap<string, number>;
}

export type TradeObjective = 'winNow' | 'balanced' | 'rebuild';

/** Blunt on purpose: enough to prefer youth, not an age curve. */
const PRIME_AGE = 26;

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
  /*
   * Surplus narrows the outgoing side; it does not gate it. A roster with
   * nothing flagged spare is the normal case, and it still has trades.
   */
  const myTradeable =
    input.surplus.length > 0 ? mine.filter((a) => input.surplus.includes(a.position)) : mine;

  const candidates: Candidate[] = [];

  for (const [partnerId, theirAssets] of assetsByTeam) {
    if (partnerId === myTeamId) continue;
    /*
     * A named player or position is a far stronger statement of intent than the
     * depth heuristic, so it replaces it rather than stacking with it — "get me
     * Stafford" should not be filtered to nothing because quarterback happened
     * not to be flagged thin.
     */
    const theirTargets =
      input.targetPlayerIds !== undefined && input.targetPlayerIds.length > 0
        ? theirAssets.filter((a) =>
            input.targetPlayerIds!.some((id) => String(id) === String(a.playerId)),
          )
        : input.targetPositions !== undefined && input.targetPositions.length > 0
          ? theirAssets.filter((a) => input.targetPositions!.includes(a.position))
          : input.needs.length > 0
            ? theirAssets.filter((a) => input.needs.includes(a.position))
            : theirAssets;

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

  const ranked = candidates
    .sort((a, b) => b.proxyScore - a.proxyScore)
    .slice(0, finalists)
    .map((candidate) =>
      evaluateTrade(
        context,
        { teamId: myTeamId, sends: candidate.iSend },
        { teamId: candidate.partnerId, sends: candidate.iGet },
      ),
    )
    .sort(
      (a, b) =>
        (b.odds.get(myTeamId)?.titleDelta ?? 0) - (a.odds.get(myTeamId)?.titleDelta ?? 0),
    );

  /*
   * Ranked, not filtered.
   *
   * Requiring a positive title delta looks like quality control and behaves like
   * a coin flip. A season simulated `n` times resolves probability no finer than
   * about `2/sqrt(n)`, and most single-player moves are smaller than that — so
   * the sign of the delta is sampling noise, roughly half of every genuine
   * upgrade was thrown away, and the page reported that no good trades existed.
   * That was a statement about the filter, not about the trade market.
   *
   * The ranking still puts the best first. Returning the closest few when
   * nothing clears the bar is a real answer; an empty page reads as broken.
   */
  const floor = 2 / Math.sqrt(context.iterations ?? 4_000);
  const objective = input.objective ?? 'balanced';

  /** Net years of youth acquired. Unknown ages count as prime, never young. */
  const youthGain = (evaluation: TradeEvaluation): number => {
    const ages = input.ages;
    if (ages === undefined) return 0;

    const meanAge = (assets: readonly TradeAsset[]): number => {
      const known = assets
        .map((asset) => ages.get(String(asset.playerId)))
        .filter((age): age is number => age !== undefined);
      return known.length === 0 ? PRIME_AGE : known.reduce((a, b) => a + b, 0) / known.length;
    };

    return meanAge(evaluation.sideA.sends) - meanAge(evaluation.sideB.sends);
  };

  /*
   * A rebuilding team should happily accept a package that lowers its odds this
   * season — that is the trade, present production for future assets — so it
   * ranks on market value and youth instead. Ranking it on title odds would
   * reject every rebuild trade there is.
   */
  if (objective === 'rebuild') {
    const byValue = [...ranked].sort(
      (a, b) =>
        (b.valueDelta.get(myTeamId) ?? 0) - (a.valueDelta.get(myTeamId) ?? 0) ||
        youthGain(b) - youthGain(a),
    );
    const gains = byValue.filter((evaluation) => (evaluation.valueDelta.get(myTeamId) ?? 0) > 0);
    return gains.length > 0 ? gains : byValue.slice(0, 3);
  }

  const helpful = ranked.filter(
    (evaluation) => (evaluation.odds.get(myTeamId)?.titleDelta ?? 0) > floor,
  );

  return helpful.length > 0 ? helpful : ranked.slice(0, 3);
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
