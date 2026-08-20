import type { PlayerId, Position } from '../domain/index.js';
import { starterPoints, withRosterChange } from '../sim/roster-projection.js';
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
  /**
   * Change in projected starter points over the remaining season, per team.
   *
   * Exact rather than simulated, which is what makes it readable in the
   * preseason when the odds deltas are still below the noise floor.
   */
  readonly pointsDelta: ReadonlyMap<string, number>;
  /** How lopsided in market terms, 0 = even. */
  readonly fairness: number;
  readonly verdict: string;
  /**
   * True when the title-odds move is smaller than this simulation can resolve.
   *
   * Reported rather than hidden: "too close to call at 4,000 iterations" is a
   * finding, and silently filtering these out is what made the trade page look
   * like it had nothing to say.
   */
  readonly belowNoiseFloor: boolean;
  /**
   * The smallest title-odds move this evaluation could distinguish, as a
   * probability. Shown so "+2.7%" and "too close to call" stop looking like a
   * contradiction — at 1,200 iterations they aren't.
   */
  readonly resolution: number;
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

/**
 * Smallest title-probability move worth reading as a signal.
 *
 * A season simulated `n` times resolves probability no finer than a couple of
 * standard errors, and common random numbers only cancel the shared part of the
 * noise. Below this, "up 0.02%" and "down 0.02%" are the same answer, and a
 * verdict that distinguishes them is inventing precision it does not have.
 */
export const noiseFloor = (iterations: number): number => 2 / Math.sqrt(iterations);

const describeVerdict = (
  myTitleDelta: number,
  theirTitleDelta: number,
  gap: number,
  myPointsDelta: number,
  floor: number,
): string => {
  // Preseason, and after any small move: the odds cannot separate these, so the
  // verdict falls back to the currency that can.
  if (Math.abs(myTitleDelta) < floor) {
    if (myPointsDelta > 0) {
      return gap > 0.25
        ? 'adds starter points, but lopsided enough that they will likely refuse'
        : 'too close to call in title odds — but it adds starter points';
    }
    if (myPointsDelta < 0) return 'too close to call in title odds, and costs starter points';
    return 'no measurable effect either way';
  }

  if (myTitleDelta < 0) return 'declines your odds — pass';
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

  const pointsA = starterPointsDelta(context, sideA.teamId, sideB.sends, sideA.sends);
  const pointsB = starterPointsDelta(context, sideB.teamId, sideA.sends, sideB.sends);

  const gap = fairnessGap(valueA, valueB);
  const floor = noiseFloor(context.iterations ?? 4_000);

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
    pointsDelta: new Map([
      [sideA.teamId, pointsA],
      [sideB.teamId, pointsB],
    ]),
    fairness: gap,
    verdict: describeVerdict(deltaA.titleDelta, deltaB.titleDelta, gap, pointsA, floor),
    belowNoiseFloor: Math.abs(deltaA.titleDelta) < floor,
    resolution: floor,
  };
};

/** Starter points gained by one team from receiving `add` and sending `drop`. */
const starterPointsDelta = (
  context: SimContext,
  teamId: string,
  add: readonly TradeAsset[],
  drop: readonly TradeAsset[],
  weeks: readonly number[] = context.weeks,
): number => {
  const team = context.teams.find((t) => t.teamId === teamId);
  if (team === undefined) return 0;

  const after = withRosterChange(team, {
    add: add.map((asset) => asset.playerId),
    drop: drop.map((asset) => asset.playerId),
  });

  return starterPoints(after, context.pool, weeks) - starterPoints(team, context.pool, weeks);
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
   * Most valuable assets considered per side.
   *
   * Enumeration is cubic in this number — every 2-for-1 pairs two of my assets
   * against one of theirs — so a dynasty roster of 27 players against nine
   * partners generates well over a hundred thousand packages, each costing a
   * lineup solve to score. Capping at the top of each roster by market value
   * loses nothing real: a trade built from a manager's twentieth-best player is
   * not a trade anyone proposes.
   */
  readonly assetCap?: number;
  /**
   * Packages surviving the cheap arithmetic screen to get a real lineup solve.
   *
   * The screens exist because enumeration is cubic: a deep dynasty roster
   * generates tens of thousands of packages, and solving a lineup for each one
   * cost the better part of a minute.
   */
  readonly prescreen?: number;
  /**
   * What the manager is trying to do, which changes what "a good trade" means.
   *
   * A contender and a rebuilding team can look at the same package and both be
   * right to disagree: one is buying this season's starter points, the other is
   * buying assets that will still be assets in two years. Ranking both on the
   * same number tells one of them the wrong thing.
   */
  readonly objective?: TradeObjective;
  /** Only propose packages that acquire one of these players. */
  readonly targetPlayerIds?: readonly PlayerId[];
  /** Only propose packages that acquire one of these positions. */
  readonly targetPositions?: readonly Position[];
  /**
   * Player ages, for the objectives that care. Missing ages are treated as
   * prime-age rather than guessed at.
   */
  readonly ages?: ReadonlyMap<string, number>;
}

export type TradeObjective = 'winNow' | 'balanced' | 'rebuild';

/**
 * Age past which a player is a depreciating asset in dynasty terms.
 *
 * Deliberately blunt. The point is not to model an age curve here — it is to
 * let "rebuild" prefer youth and "win now" ignore it, and any threshold in the
 * high twenties does that. Position-specific curves belong in the projection
 * model, not in a trade filter.
 */
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
  const objective = input.objective ?? 'balanced';
  const band = input.fairnessBand ?? 0.15;
  const finalists = input.finalists ?? 10;

  const mine = assetsByTeam.get(myTeamId) ?? [];

  /**
   * Needs and surplus narrow the search; they do not gate it.
   *
   * Treating them as required meant a roster with no position flagged "thin" and
   * none flagged "surplus" enumerated zero candidates and the page reported that
   * no good trades existed — a statement about the depth heuristic, not about
   * the trade market. A balanced roster is the normal case, and it still has
   * trades available. When either list is empty every tradeable position is
   * eligible, and the market-value fairness band does the filtering it was
   * designed to do.
   */
  const cap = input.assetCap ?? 12;

  /** The most valuable few, since nobody trades from the bottom of a roster. */
  const topByValue = (assets: readonly TradeAsset[]): readonly TradeAsset[] =>
    [...assets].sort((a, b) => b.value - a.value).slice(0, cap);

  const myTradeable = topByValue(
    input.surplus.length > 0 ? mine.filter((a) => input.surplus.includes(a.position)) : mine,
  );

  /**
   * The cheap ranking proxy: starter points this package gains me.
   *
   * The previous proxy was market value gained net of value sent, which sounds
   * reasonable and is nearly useless here — every candidate has already passed a
   * ±15% fairness band, so that quantity is close to zero for all of them and
   * the "top" finalists were effectively arbitrary. Starter points measure the
   * thing being optimized, cost one lineup solve rather than a simulation, and
   * correctly rate a fair trade that fixes a hole above a fair trade that
   * shuffles depth.
   */
  /*
   * Two screens, cheapest first.
   *
   * Enumeration is cubic, so even a capped search produces tens of thousands of
   * packages, and a lineup solve on each one was making the trade page take the
   * better part of a minute on a deep dynasty roster.
   *
   * The first screen is pure arithmetic — points coming in minus points going
   * out, no lineup involved. It is wrong in an important way (it cannot see
   * that a package leaves a starting slot empty) but it is nearly free and it
   * is more than good enough to throw away the obvious dross.
   *
   * The survivors then get the real proxy: an actual lineup solve, which does
   * see positional holes. That runs hundreds of times rather than tens of
   * thousands, and the finalists are simulated properly after that.
   */
  const proxyWeeks = context.weeks.slice(0, 1);
  const weekly = proxyWeeks[0] === undefined ? undefined : context.pool.get(proxyWeeks[0]);
  const meanOf = (asset: TradeAsset): number => weekly?.get(asset.playerId)?.mean ?? 0;
  const sumMean = (assets: readonly TradeAsset[]): number =>
    assets.reduce((total, asset) => total + meanOf(asset), 0);

  const cheapScore = (iSend: readonly TradeAsset[], iGet: readonly TradeAsset[]): number =>
    sumMean(iGet) - sumMean(iSend);

  const proxyScore = (iSend: readonly TradeAsset[], iGet: readonly TradeAsset[]): number =>
    starterPointsDelta(context, myTeamId, iGet, iSend, proxyWeeks);

  const candidates: Candidate[] = [];

  /*
   * A package is a set, not a sequence.
   *
   * The 2-for-1 loop pairs every offer with every sweetener, which reaches the
   * same pair from both directions — so "Allen and Nailor for Stafford" was
   * enumerated twice and surfaced twice, making the proposal list look padded
   * and, worse, making a duplicate crowd out a genuinely different trade.
   */
  const seen = new Set<string>();
  const signature = (iSend: readonly TradeAsset[], iGet: readonly TradeAsset[]): string =>
    [
      iSend.map((a) => String(a.playerId)).sort().join('+'),
      iGet.map((a) => String(a.playerId)).sort().join('+'),
    ].join('>');

  for (const [partnerId, theirAssets] of assetsByTeam) {
    if (partnerId === myTeamId) continue;
    /*
     * Narrow the incoming side to what was asked for, when anything was.
     *
     * A named player or a named position is a much stronger statement of intent
     * than the depth heuristic, so it replaces it rather than stacking with it —
     * "get me Stafford" should not be silently filtered down to nothing because
     * quarterback was not flagged thin.
     */
    const wanted =
      input.targetPlayerIds !== undefined && input.targetPlayerIds.length > 0
        ? theirAssets.filter((a) =>
            input.targetPlayerIds!.some((id) => String(id) === String(a.playerId)),
          )
        : input.targetPositions !== undefined && input.targetPositions.length > 0
          ? theirAssets.filter((a) => input.targetPositions!.includes(a.position))
          : input.needs.length > 0
            ? theirAssets.filter((a) => input.needs.includes(a.position))
            : theirAssets;

    const theirTargets = topByValue(wanted);

    for (const target of theirTargets) {
      for (const offer of myTradeable) {
        // 1-for-1
        pushIfFair(candidates, partnerId, [offer], [target], band, cheapScore, seen, signature);

        // 2-for-1: sweeten with a second piece when the target is worth more.
        for (const sweetener of myTradeable) {
          if (sweetener.playerId === offer.playerId) continue;
          pushIfFair(candidates, partnerId, [offer, sweetener], [target], band, cheapScore, seen, signature);
        }
      }

      // 1-for-2: take back a second piece when my offer is the bigger asset.
      for (const offer of myTradeable) {
        for (const extra of theirTargets) {
          if (extra.playerId === target.playerId) continue;
          pushIfFair(candidates, partnerId, [offer], [target, extra], band, cheapScore, seen, signature);
        }
      }
    }
  }

  /*
   * Second screen: re-score the cheap survivors with a real lineup solve.
   *
   * `prescreen` is the only number here that trades quality for time. It is
   * generous relative to `finalists` precisely because the cheap screen is
   * blind to positional holes, and this pass exists to catch them.
   */
  const prescreen = input.prescreen ?? 250;
  const shortlist = candidates.sort((a, b) => b.proxyScore - a.proxyScore).slice(0, prescreen);

  const ranked = shortlist
    .map((candidate) => ({
      ...candidate,
      proxyScore: proxyScore(candidate.iSend, candidate.iGet),
    }))
    .sort((a, b) => b.proxyScore - a.proxyScore)
    .slice(0, finalists);

  const evaluations = ranked.map((candidate) =>
    evaluateTrade(
      context,
      { teamId: myTeamId, sends: candidate.iSend },
      { teamId: candidate.partnerId, sends: candidate.iGet },
    ),
  );

  /**
   * Rank on the currency that can actually resolve the difference.
   *
   * Where the title-odds move clears the noise floor it decides the order,
   * because it is the number that matters. Where it doesn't — every preseason
   * evaluation, and plenty of in-season ones — ordering by it would be sorting
   * on sampling noise, so starter points decide instead.
   */
  const floor = noiseFloor(context.iterations ?? 4_000);

  /**
   * Net years of youth acquired: how much younger the incoming side is.
   *
   * Only consulted by the rebuild and win-now objectives, and only as a
   * tie-breaker on top of the currencies that measure football.
   */
  const youthGain = (evaluation: TradeEvaluation): number => {
    const ages = input.ages;
    if (ages === undefined) return 0;

    const meanAge = (assets: readonly TradeAsset[]): number => {
      const known = assets
        .map((asset) => ages.get(String(asset.playerId)))
        .filter((age): age is number => age !== undefined);
      // An unknown age is treated as prime rather than guessed at, so a missing
      // birthdate cannot masquerade as a young asset.
      return known.length === 0 ? PRIME_AGE : known.reduce((a, b) => a + b, 0) / known.length;
    };

    return meanAge(evaluation.sideA.sends) - meanAge(evaluation.sideB.sends);
  };

  const rank = (evaluation: TradeEvaluation): readonly [number, number] => {
    const titleDelta = evaluation.odds.get(myTeamId)?.titleDelta ?? 0;
    const points = evaluation.pointsDelta.get(myTeamId) ?? 0;
    const value = evaluation.valueDelta.get(myTeamId) ?? 0;
    const resolved = Math.abs(titleDelta) >= floor ? titleDelta : 0;

    /*
     * Each objective ranks on the thing it is actually buying.
     *
     * win-now: this season's points, and the odds when they can be resolved.
     *   Youth given up is not a cost worth counting for a team trying to win
     *   the title this year.
     *
     * rebuild: market value and youth. A rebuilding team should happily take a
     *   package that lowers its starter points, because that is the trade —
     *   present production for future assets — and a ranker that punishes the
     *   points loss would refuse every rebuild trade there is.
     *
     * balanced: the default, unchanged.
     */
    if (objective === 'winNow') return [resolved, points] as const;
    if (objective === 'rebuild') return [value, youthGain(evaluation)] as const;
    return [resolved, points] as const;
  };

  const sorted = [...evaluations].sort((a, b) => {
    const [titleA, pointsA] = rank(a);
    const [titleB, pointsB] = rank(b);
    return titleB - titleA || pointsB - pointsA;
  });

  /**
   * Anything that helps on either currency is worth showing.
   *
   * If nothing does, the best few are returned anyway: "here are the closest
   * trades available and none of them improve you" is a real answer that a
   * manager can act on, and an empty page is not — it reads as a broken tool.
   */
  const helpful = sorted.filter((evaluation) => {
    const [primary, secondary] = rank(evaluation);
    return primary > 0 || secondary > 0;
  });

  return helpful.length > 0 ? helpful : sorted.slice(0, 3);
};

const pushIfFair = (
  into: Candidate[],
  partnerId: string,
  iSend: readonly TradeAsset[],
  iGet: readonly TradeAsset[],
  band: number,
  proxyScoreOf: (iSend: readonly TradeAsset[], iGet: readonly TradeAsset[]) => number,
  seen: Set<string>,
  signature: (iSend: readonly TradeAsset[], iGet: readonly TradeAsset[]) => string,
): void => {
  const sendValue = sumValue(iSend);
  const getValue = sumValue(iGet);
  if (fairnessGap(sendValue, getValue) > band) return;

  const key = `${partnerId}|${signature(iSend, iGet)}`;
  if (seen.has(key)) return;
  seen.add(key);

  into.push({ partnerId, iSend, iGet, proxyScore: proxyScoreOf(iSend, iGet) });
};
