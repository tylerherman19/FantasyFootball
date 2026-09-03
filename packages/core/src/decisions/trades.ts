import type { PlayerId, Position } from '../domain/index.js';
import { currentOdds, oddsDelta, type OddsDelta, type SimContext } from './odds.js';
import { evaluatePlayer, type PlayerEvaluationInput } from '../valuation/player-evaluation.js';
import { isExpendable } from '../metrics/marginal-value.js';

/**
 * Trades, priced in both currencies at once.
 *
 * Model value (points above replacement, valuation/edge-value.ts) answers "is
 * this fair". Championship probability answers "is this good for me" — the
 * question that actually matters. Tools that report only the first tell you a trade is even
 * when it does nothing for your season; tools that report only the second
 * propose trades nobody would ever accept.
 *
 * Both sides see both numbers, which is what ends the argument.
 */

interface TradeAssetBase {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly position: Position;
  /** The model's own price: points above replacement (edge-value). */
  readonly value: number;
  /** Current-season projection used for replacement-aware screening. */
  readonly projectedPoints?: number;
  /** Age in years; absent means unknown, never youth by assumption. */
  readonly age?: number;
  /** Bounded current scheme signal. It is intentionally a tie-breaker only. */
  readonly schemeFit?: number;
  /** Predictive standard deviation in current-season fantasy points. */
  readonly sd?: number;
  /** Confidence in the model evidence behind the projection, 0 to 1. */
  readonly modelConfidence?: number;
  /** Outcome scenarios from the same distribution as the season simulator. */
  readonly quantiles?: {
    readonly p25: number;
    readonly p50: number;
    readonly p75: number;
  };
  readonly weeklyPoints?: number;
}

/** A rostered player: role-aware and eligible for lineup replacement analysis. */
export interface TradePlayerAsset extends TradeAssetBase {
  readonly kind: 'player';
}

/** A draft pick: a trade asset, but never a lineup participant. */
export interface TradePickAsset extends TradeAssetBase {
  readonly kind: 'pick';
  readonly yearsOut?: number;
  readonly round?: number;
}

/** Asset types stay discriminated so player-only logic cannot swallow picks. */
export type TradeAsset = TradePlayerAsset | TradePickAsset;

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
  /** Estimated probability that the partner sees a usable trade, 0 to 1. */
  readonly acceptanceScore: number;
  /** Replacement-aware fit for the requesting team, 0 to 1. */
  readonly fitScore: number;
  /** Difference in current scheme signal, positive favours the receiving side. */
  readonly schemeDelta: number;
  /** Composite ranking score used by the finder, 0 to 100. */
  readonly recommendationScore: number;
  /** Average evidence confidence of the assets changing hands. */
  readonly evidenceScore: number;
  /** Short, inspectable reasons behind the ranking. */
  readonly rationale: readonly string[];
  readonly verdict: string;
  readonly strategy?: {
    readonly objective: TradeObjective;
    readonly futureValueDelta: number;
    readonly explanation: string;
  };
}

const sumValue = (assets: readonly TradeAsset[]): number =>
  assets.reduce((total, asset) => total + asset.value, 0);

/**
 * Value fairness as a proportion of the larger side.
 *
 * Proportional rather than absolute because 50 points of PAR means something
 * very different in a trade of backups than in one involving two first-rounders.
 */
export const fairnessGap = (valueA: number, valueB: number): number => {
  const larger = Math.max(valueA, valueB);
  return larger <= 0 ? 0 : Math.abs(valueA - valueB) / larger;
};

export interface TradeRosterProfile {
  /** What the team's optimal lineup loses if a player leaves. */
  readonly marginalByPlayer: ReadonlyMap<string, number>;
  /** Whether the player is currently in the optimal lineup. */
  readonly startingByPlayer: ReadonlyMap<string, boolean>;
  /** How exposed the team is at each position. */
  readonly exposureByPosition: ReadonlyMap<Position, number>;
}

export interface TradeIntelligenceOptions {
  readonly rosterProfiles?: ReadonlyMap<string, TradeRosterProfile>;
  readonly objective?: TradeObjective;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const averageScheme = (assets: readonly TradeAsset[]): number => {
  const known = assets
    .map((asset) => asset.schemeFit)
    .filter((value): value is number => value !== undefined);
  return known.length === 0 ? 0 : known.reduce((sum, value) => sum + value, 0) / known.length;
};

const lineupHelp = (
  profile: TradeRosterProfile | undefined,
  asset: TradeAsset,
  objective: TradeObjective = 'balanced',
): number => {
  if (profile === undefined) return 0;
  const exposure = profile.exposureByPosition.get(asset.position) ?? 0;
  const projected = asset.projectedPoints ?? 0;
  const evaluationInput: PlayerEvaluationInput = {
    projectedPoints: projected,
    // The team's current hole is the relevant replacement level. This keeps a
    // high raw projection from being counted as full value when the roster
    // only has a small starting slot for it.
    replacementPoints: Math.max(0, projected - Math.max(0, exposure)),
    objective,
    ...(asset.sd === undefined ? {} : { sd: asset.sd }),
    ...(asset.modelConfidence === undefined ? {} : { confidence: asset.modelConfidence }),
    ...(asset.quantiles === undefined ? {} : { quantiles: asset.quantiles }),
  };
  const evaluation = evaluatePlayer(evaluationInput);
  return Math.min(evaluation.evidenceAdjustedPoints, Math.max(0, exposure));
};

const outgoingCost = (profile: TradeRosterProfile | undefined, assets: readonly TradeAsset[]): number =>
  assets.reduce(
    (sum, asset) => {
      const marginal = profile?.marginalByPlayer.get(String(asset.playerId)) ?? 0;
      // Marginal value is already replacement-aware. Confidence only softens
      // the cost of giving up a fragile estimate; it never creates value.
      const confidence = clamp01(asset.modelConfidence ?? 0.75);
      return sum + marginal * (0.75 + 0.25 * confidence);
    },
    0,
  );

const averageConfidence = (assets: readonly TradeAsset[]): number => {
  if (assets.length === 0) return 0.75;
  return assets.reduce((sum, asset) => sum + clamp01(asset.modelConfidence ?? 0.75), 0) / assets.length;
};

/** Never treat a current starter as a disposable outgoing asset. */
const isTradeableOutgoing = (
  profile: TradeRosterProfile | undefined,
  asset: TradeAsset,
): boolean => {
  // Picks do not occupy lineup slots, so they have no starter/bench role.
  // They must remain eligible even when a roster profile is present.
  if (asset.kind === 'pick') return true;
  if (profile === undefined) return true;
  const playerId = String(asset.playerId);
  const starting = profile.startingByPlayer.get(playerId);
  // An incomplete role record fails closed instead of recreating the original
  // bug with a low-marginal starter.
  if (starting === undefined) return false;
  return isExpendable({
    marginal: profile.marginalByPlayer.get(playerId) ?? 0,
    starting,
  });
};

const youthYears = (sends: readonly TradeAsset[], gets: readonly TradeAsset[]): number => {
  const known = (assets: readonly TradeAsset[]): number[] =>
    assets.map((asset) => asset.age).filter((age): age is number => age !== undefined);
  const sent = known(sends);
  const received = known(gets);
  if (sent.length === 0 || received.length === 0) return 0;
  return sent.reduce((a, b) => a + b, 0) / sent.length - received.reduce((a, b) => a + b, 0) / received.length;
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
  intelligence: TradeIntelligenceOptions = {},
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
  const profileA = intelligence.rosterProfiles?.get(sideA.teamId);
  const profileB = intelligence.rosterProfiles?.get(sideB.teamId);
  const objective = intelligence.objective ?? 'balanced';
  const helpA = sideB.sends.reduce((sum, asset) => sum + lineupHelp(profileA, asset, objective), 0);
  const helpB = sideA.sends.reduce((sum, asset) => sum + lineupHelp(profileB, asset, objective), 0);
  const costA = outgoingCost(profileA, sideA.sends);
  const costB = outgoingCost(profileB, sideB.sends);
  const netA = helpA - costA;
  const netB = helpB - costB;
  const schemeDelta = averageScheme(sideB.sends) - averageScheme(sideA.sends);
  const fairness = fairnessGap(valueA, valueB);
  const marketBalance = 1 - fairness;
  const acceptanceScore = clamp01(
    0.5 * marketBalance + 0.5 * (1 / (1 + Math.exp(-netB / 6))),
  );
  const fitScore = clamp01(0.5 + netA / 20);
  const evidenceScore = clamp01(
    (averageConfidence(sideA.sends) + averageConfidence(sideB.sends)) / 2,
  );
  const titleSignal = clamp01(0.5 + deltaA.titleDelta / 0.04);
  const futureSignal = clamp01(
    0.5 + ((valueB - valueA) / Math.max(valueA, 1)) * 0.75 + youthYears(sideA.sends, sideB.sends) * 0.02,
  );
  const schemeSignal = clamp01(0.5 + schemeDelta);
  const recommendationScore =
    100 *
    (objective === 'winNow'
      ? 0.50 * titleSignal + 0.25 * acceptanceScore + 0.15 * fitScore + 0.05 * evidenceScore + 0.05 * schemeSignal
      : objective === 'rebuild'
        ? 0.15 * titleSignal + 0.25 * acceptanceScore + 0.3 * futureSignal + 0.15 * fitScore + 0.10 * evidenceScore + 0.05 * schemeSignal
        : 0.35 * titleSignal + 0.3 * acceptanceScore + 0.25 * fitScore + 0.05 * evidenceScore + 0.05 * schemeSignal);
  const rationale = [
    acceptanceScore >= 0.65
      ? 'market-balanced and useful to the other roster'
      : 'acceptance depends on the partner valuing the fit',
    fitScore >= 0.6 ? 'fills a replacement-level hole on your roster' : 'limited immediate lineup gain',
    evidenceScore >= 0.65
      ? 'projection is supported by substantial recent evidence'
      : 'projection carries meaningful evidence risk — treat the mean as a range',
    Math.abs(schemeDelta) >= 0.15
      ? schemeDelta > 0
        ? 'scheme context favours what you receive'
        : 'scheme context favours what you send'
      : 'scheme is close to neutral',
  ];

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
    fairness,
    acceptanceScore,
    fitScore,
    schemeDelta,
    recommendationScore,
    evidenceScore,
    rationale,
    verdict: describeVerdict(deltaA.titleDelta, deltaB.titleDelta, fairness),
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
  /** Only propose trades within this value band. */
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
  /** Replacement-aware roster context, keyed by team id. */
  readonly rosterProfiles?: ReadonlyMap<string, TradeRosterProfile>;
}

export type TradeObjective = 'winNow' | 'balanced' | 'rebuild';

const rebuildMultiplier = (position: Position, age: number | undefined): number => {
  if (age === undefined) return 1;
  if (position === 'QB') return age <= 25 ? 1.12 : age <= 29 ? 1.05 : age <= 32 ? 0.92 : 0.75;
  if (position === 'RB') return age <= 23 ? 1.18 : age <= 25 ? 1.08 : age <= 27 ? 0.9 : 0.65;
  if (position === 'WR') return age <= 24 ? 1.18 : age <= 27 ? 1.06 : age <= 29 ? 0.9 : 0.68;
  if (position === 'TE') return age <= 25 ? 1.15 : age <= 28 ? 1.05 : age <= 30 ? 0.9 : 0.7;
  return age <= 25 ? 1.1 : age <= 28 ? 1 : 0.75;
};

/**
 * What a package is worth to a rebuilding team, summed in the model's own
 * currency.
 *
 * For players in dynasty formats that currency is already the right one:
 * edge-value prices four seasons of points above replacement with the measured
 * age curves applied, which *is* "what will this be worth when we are good
 * again." Picks likewise arrive priced off the model's own rookie class. The
 * old version re-blended in a market anchor and a hand-set decline table; both
 * are gone, so the package value is simply the sum of the model's prices.
 */
const rebuildPackageValue = (assets: readonly TradeAsset[]): number =>
  assets.reduce((total, asset) => total + asset.value, 0);

/**
 * A young cornerstone is defined relatively, not against a feed's scale: worth
 * at least as much as a mid-first-round pick (the chart's own price for slot
 * 1.06 in a twelve-team sense — the median of whatever first-round picks are
 * actually in the pool) and still on the rising side of his position's curve.
 * The old cutoff was a constant on FantasyCalc's 0-9999 scale, which meant the
 * definition silently changed meaning the day the feed did.
 */
const isYoungCornerstone = (
  asset: TradeAsset,
  ages: ReadonlyMap<string, number> | undefined,
  cornerstoneCutoff: number,
): boolean => {
  const age = asset.age ?? ages?.get(String(asset.playerId));
  return asset.value >= cornerstoneCutoff && age !== undefined && rebuildMultiplier(asset.position, age) >= 1.1;
};

/**
 * The value of a mid-first-rounder, inferred from the picks actually in the
 * trade pool. With no picks present (redraft), the 90th-percentile player
 * price stands in — a cornerstone is a top-of-roster asset by definition.
 */
const cornerstoneCutoffFor = (assetsByTeam: ReadonlyMap<string, readonly TradeAsset[]>): number => {
  const firsts: number[] = [];
  const playerValues: number[] = [];
  for (const assets of assetsByTeam.values()) {
    for (const asset of assets) {
      if (asset.kind === 'pick' && asset.round === 1) firsts.push(asset.value);
      else if (asset.kind === 'player') playerValues.push(asset.value);
    }
  }
  if (firsts.length > 0) {
    firsts.sort((a, b) => a - b);
    return firsts[Math.floor(firsts.length / 2)]!;
  }
  playerValues.sort((a, b) => a - b);
  return playerValues[Math.floor(playerValues.length * 0.9)] ?? Number.POSITIVE_INFINITY;
};

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
  const mineProfile = input.rosterProfiles?.get(myTeamId);
  const myTradeable =
    (input.surplus.length > 0
      ? mine.filter((asset) => asset.kind === 'pick' || input.surplus.includes(asset.position))
      : mine)
      .filter((asset) => isTradeableOutgoing(mineProfile, asset));

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
          : input.objective === 'rebuild'
            ? theirAssets
          : input.needs.length > 0
            ? theirAssets.filter((a) => input.needs.includes(a.position))
            : theirAssets;

    for (const target of theirTargets) {
      for (const offer of myTradeable) {
        // 1-for-1
        pushIfFair(candidates, partnerId, [offer], [target], band, input);

        // 2-for-1: sweeten with a second piece when the target is worth more.
        for (const sweetener of myTradeable) {
          if (sweetener.playerId === offer.playerId) continue;
          pushIfFair(candidates, partnerId, [offer, sweetener], [target], band, input);
        }
      }

      // 1-for-2: take back a second piece when my offer is the bigger asset.
      for (const offer of myTradeable) {
        for (const extra of theirTargets) {
          if (extra.playerId === target.playerId) continue;
          pushIfFair(candidates, partnerId, [offer], [target, extra], band, input);
        }
      }
    }
  }

  // The raw search is ordered by a cheap lineup/fit proxy, but a single
  // partner can generate many equally fair packages. Keep the screen broad
  // and reserve room for multiple opposing rosters.
  const objective = input.objective ?? 'balanced';
  const cornerstoneCutoff = cornerstoneCutoffFor(assetsByTeam);
  const viableCandidates = objective === 'rebuild'
    ? candidates.filter((candidate) => {
        const sent = rebuildPackageValue(candidate.iSend);
        const received = rebuildPackageValue(candidate.iGet);
        const protectsCornerstone = candidate.iSend.some((asset) => isYoungCornerstone(asset, input.ages, cornerstoneCutoff));
        const requiredGain = protectsCornerstone ? sent * 0.05 : Math.max(50, sent * 0.01);
        return received - sent >= requiredGain;
      })
    : candidates;

  const topCandidates = viableCandidates
    .sort((a, b) => objective === 'rebuild'
      ? (rebuildPackageValue(b.iGet) - rebuildPackageValue(b.iSend)) -
        (rebuildPackageValue(a.iGet) - rebuildPackageValue(a.iSend))
      : b.proxyScore - a.proxyScore)
    .reduce((selected, candidate) => {
      if (selected.length >= finalists) return selected;
      const partnerCount = selected.filter((item) => item.partnerId === candidate.partnerId).length;
      if (partnerCount >= 3) return selected;
      selected.push(candidate);
      return selected;
    }, [] as Candidate[]);

  const ranked = topCandidates
    .map((candidate) => {
      const intelligence: TradeIntelligenceOptions = {
        ...(input.rosterProfiles === undefined ? {} : { rosterProfiles: input.rosterProfiles }),
        ...(input.objective === undefined ? {} : { objective: input.objective }),
      };
      const evaluation = evaluateTrade(
        context,
        { teamId: myTeamId, sends: candidate.iSend },
        { teamId: candidate.partnerId, sends: candidate.iGet },
        intelligence,
      );
      if (objective !== 'rebuild') return evaluation;
      const futureValueDelta =
        rebuildPackageValue(candidate.iGet) -
        rebuildPackageValue(candidate.iSend);
      return {
        ...evaluation,
        strategy: {
          objective,
          futureValueDelta,
          explanation: 'Rebuild score uses position-specific career curves and protects young, high-value cornerstones from marginal upgrades.',
        },
      };
    })
    .sort(
      (a, b) =>
        b.recommendationScore - a.recommendationScore ||
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
  /*
   * A rebuilding team should happily accept a package that lowers its odds this
   * season — that is the trade, present production for future assets — so it
   * ranks on market value and youth instead. Ranking it on title odds would
   * reject every rebuild trade there is.
   */
  if (objective === 'rebuild') {
    return [...ranked].sort(
      (a, b) => (b.strategy?.futureValueDelta ?? 0) - (a.strategy?.futureValueDelta ?? 0),
    );
  }

  const helpful = ranked.filter(
    (evaluation) => (evaluation.odds.get(myTeamId)?.titleDelta ?? 0) > floor,
  );

  return helpful.length > 0 ? helpful : ranked.slice(0, finalists);
};

const hasDuplicatePosition = (assets: readonly TradeAsset[]): boolean => {
  // Picks do not have positional scarcity. Two picks are a valid package; the
  // duplicate-position rule applies only to player assets.
  const playerPositions = assets
    .filter((asset) => asset.kind === 'player')
    .map((asset) => asset.position);
  return new Set(playerPositions).size !== playerPositions.length;
};

const pushIfFair = (
  into: Candidate[],
  partnerId: string,
  iSend: readonly TradeAsset[],
  iGet: readonly TradeAsset[],
  band: number,
  input: TradeFinderInput,
): void => {
  // A real offer should not bundle two players from the same position unless
  // the target side is also taking that position. Duplicate-position bundles
  // are usually a roster dump, not a credible dynasty proposal.
  if (hasDuplicatePosition(iSend) || hasDuplicatePosition(iGet)) return;

  const sendValue = sumValue(iSend);
  const getValue = sumValue(iGet);
  if (fairnessGap(sendValue, getValue) > band) return;

  const mine = input.rosterProfiles?.get(input.myTeamId);
  const partner = input.rosterProfiles?.get(partnerId);
  const objective = input.objective ?? 'balanced';
  const myHelp = iGet.reduce((sum, asset) => sum + lineupHelp(mine, asset, objective), 0);
  const partnerHelp = iSend.reduce((sum, asset) => sum + lineupHelp(partner, asset, objective), 0);
  const myCost = outgoingCost(mine, iSend);
  const scheme = averageScheme(iGet) - averageScheme(iSend);

  // Cheap screen: prioritize actual lineup help and partner fit, then use
  // value as a guardrail/tie-breaker. Full simulation still decides the
  // final order, so the screen cannot turn a proxy into a recommendation.
  // The 0.01 weight keeps the value term at the same magnitude it had on the
  // old 0-9999 market scale: edge values are annualized points, roughly a
  // hundred times smaller.
  into.push({
    partnerId,
    iSend,
    iGet,
    proxyScore: myHelp - myCost + partnerHelp * 0.35 + scheme + (getValue - sendValue) * 0.01,
  });
};
