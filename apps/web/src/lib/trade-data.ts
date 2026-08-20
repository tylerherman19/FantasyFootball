import {
  analyzeRosters,
  asPlayerId,
  assessDepth,
  findTrades,
  marginalValues,
  offerCandidates,
  rankPartners,
  type FitScore,
  type DepthAssessment,
  type LineupCandidate,
  type Position,
  type TradeAsset,
  type TradeEvaluation,
} from '@ffe/core';
import { unstable_cache } from 'next/cache';
import { loadIdentities } from './crosswalk';
import type { LeagueView } from './league-data';
import { loadArtifact, scoreFor } from './projections';
import { loadMarketData } from './values';

/**
 * Trade suggestions for one team.
 *
 * Combines the two halves the plan calls for: market value decides whether a
 * proposal is plausible, simulation decides whether it is good for you. Neither
 * alone is enough — value-only tools call a trade "even" when it does nothing
 * for your season, odds-only tools propose fleeces nobody would accept.
 */

/**
 * Iteration counts for the server-rendered proposal list.
 *
 * Kept deliberately low. Precision here buys little: the list exists to suggest
 * *which* trades to look at, and anything a user acts on gets re-graded at full
 * precision in the interactive calculator, which runs in their browser. Spending
 * ten seconds of server time to refine a suggestion nobody clicked is the wrong
 * trade.
 */
const SCREEN_ITERATIONS = 300;
const FINALIST_ITERATIONS = 1_200;
const FINALIST_COUNT = 3;

/**
 * Positions worth trading.
 *
 * Kickers and team defenses are streamed off the wire every week, so a model
 * that notices you are "short a kicker" and proposes a trade for one is
 * technically correct and practically useless. They are excluded rather than
 * ranked low, because the right number of trade offers for a kicker is zero.
 */
const TRADEABLE: readonly Position[] = ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB'];

export interface TradeView {
  readonly evaluations: readonly TradeEvaluation[];
  readonly needs: readonly Position[];
  readonly surplus: readonly Position[];
  readonly valuesAvailable: boolean;
  /** Per-position depth, with the reasoning shown rather than asserted. */
  readonly depth: readonly DepthAssessment[];
  /** Partners ranked by how well the two rosters complement each other. */
  readonly partners: readonly (FitScore & {
    offers: readonly {
      playerId: string;
      name: string;
      position: string;
      projected: number;
      helpsThemBy: number;
    }[];
  })[];
  /** Marginal value per player, best first — who you can actually move. */
  readonly marginal: readonly {
    playerId: string;
    name: string;
    position: string;
    marginal: number;
    projected: number;
    value: number;
  }[];
}

/**
 * What this roster is actually short of and can actually spare.
 *
 * Judged by consequence, not headcount: a position is surplus only when it
 * holds players whose departure would not change the optimal lineup, and thin
 * when the whole position rests on one player. Counting bodies against slots
 * produces confident nonsense like "you can spare a running back" about a
 * roster whose backs fill both flex spots.
 */
const inferNeeds = (
  depth: readonly DepthAssessment[],
): { needs: Position[]; surplus: Position[] } => {
  const needs: Position[] = [];
  const surplus: Position[] = [];

  for (const assessment of depth) {
    const position = assessment.position as Position;
    if (!TRADEABLE.includes(position)) continue;

    if (assessment.verdict === 'thin') needs.push(position);
    else if (assessment.verdict === 'surplus') surplus.push(position);
  }

  return { needs, surplus };
};

export interface TradeQuery {
  readonly objective?: 'winNow' | 'balanced' | 'rebuild';
  readonly targetPlayerId?: string | null;
  readonly targetPosition?: string | null;
}

/*
 * The trade search, cached where a cold instance can reach it.
 *
 * Enumerating packages across every roster and simulating the survivors is the
 * most expensive thing this app does after the season itself, and like the
 * season it is deterministic — same rosters, same seed, same answer. So it goes
 * through the data cache rather than being recomputed by whichever instance
 * happens to take the request.
 *
 * `TradeEvaluation` carries its per-team numbers in Maps, which do not survive
 * JSON, so they are written out as entries and rebuilt on the way back. That is
 * the only reason this wrapper exists.
 */
interface CachedTrades {
  readonly evaluations: readonly {
    readonly sideA: TradeEvaluation['sideA'];
    readonly sideB: TradeEvaluation['sideB'];
    readonly odds: readonly (readonly [string, TradeEvaluation['odds'] extends ReadonlyMap<string, infer V> ? V : never])[];
    readonly valueDelta: readonly (readonly [string, number])[];
    readonly fairness: number;
    readonly verdict: string;
  }[];
  readonly needs: TradeView['needs'];
  readonly surplus: TradeView['surplus'];
  readonly valuesAvailable: boolean;
  readonly depth: TradeView['depth'];
  readonly partners: TradeView['partners'];
  readonly marginal: TradeView['marginal'];
}

const toCacheable = (view: TradeView): CachedTrades => ({
  ...view,
  evaluations: view.evaluations.map((evaluation) => ({
    sideA: evaluation.sideA,
    sideB: evaluation.sideB,
    odds: [...evaluation.odds.entries()],
    valueDelta: [...evaluation.valueDelta.entries()],
    fairness: evaluation.fairness,
    verdict: evaluation.verdict,
  })),
});

const fromCacheable = (cached: CachedTrades): TradeView => ({
  ...cached,
  evaluations: cached.evaluations.map((evaluation) => ({
    ...evaluation,
    odds: new Map(evaluation.odds.map(([k, v]) => [k, v])),
    valueDelta: new Map(evaluation.valueDelta.map(([k, v]) => [k, v])),
  })) as unknown as readonly TradeEvaluation[],
});

export const loadTrades = async (
  view: LeagueView,
  teamId: string,
  query: TradeQuery = {},
): Promise<TradeView | null> => {
  const rosterSignature = view.snapshot.rosters
    .map((roster) => `${roster.teamId}:${[...roster.playerIds].sort().join('.')}`)
    .join('|');

  const cached = await unstable_cache(
    async () => {
      const result = await buildTrades(view, teamId, query);
      return result === null ? null : toCacheable(result);
    },
    [
      'trade-search',
      view.snapshot.league.id,
      String(view.snapshot.asOfWeek),
      teamId,
      query.objective ?? 'balanced',
      query.targetPlayerId ?? '',
      query.targetPosition ?? '',
      rosterSignature,
    ],
    { revalidate: 900 },
  )();

  return cached === null ? null : fromCacheable(cached);
};

const buildTrades = async (
  view: LeagueView,
  teamId: string,
  query: TradeQuery = {},
): Promise<TradeView | null> => {
  const { snapshot, context } = view;

  const artifact = await loadArtifact(snapshot.league.season, snapshot.asOfWeek);
  if (artifact === null) return null;

  const market = await loadMarketData(snapshot.league.format, snapshot.league.superFlex);
  const values = market.players;

  const assetFor = (playerId: string): TradeAsset | null => {
    const projection = artifact.players[playerId];
    const market = values.get(playerId);
    if (projection === undefined || market === undefined) return null;

    return {
      playerId: asPlayerId(playerId),
      name: projection.name || market.name,
      position: projection.position as Position,
      value: market.value,
    };
  };

  const assetsByTeam = new Map<string, TradeAsset[]>();
  for (const roster of snapshot.rosters) {
    const assets = roster.playerIds
      .map((id) => assetFor(String(id)))
      .filter((asset): asset is TradeAsset => asset !== null);
    assetsByTeam.set(roster.teamId, assets);
  }

  // Marginal value of every player on my roster: what the optimal lineup loses
  // without them. This is what "spare" actually means.
  const myRoster = snapshot.rosters.find((r) => r.teamId === teamId);
  const candidates: LineupCandidate[] = (myRoster?.playerIds ?? []).flatMap((id) => {
    const projection = artifact.players[String(id)];
    if (projection === undefined || !projection.active) return [];
    const position = projection.position as Position;
    return [
      {
        playerId: asPlayerId(String(id)),
        position,
        eligiblePositions: [position],
        projectedPoints: scoreFor(projection, snapshot.league.scoring.raw),
        stddev: projection.sd,
      },
    ];
  });

  const positionById = new Map(candidates.map((c) => [String(c.playerId), c.position]));
  const marginal = marginalValues(candidates, snapshot.league.rosterSlots).map((value) => ({
    ...value,
    position: positionById.get(String(value.playerId)) ?? '?',
  }));

  const depth = assessDepth(marginal);
  const { needs, surplus } = inferNeeds(depth);

  /**
   * Every roster in the league gets the same counterfactual treatment.
   *
   * A proposal only happens when the piece being offered is worth more to the
   * other manager than what they give up, and that cannot be known without
   * analysing their roster too. This is what separates a trade finder from a
   * wish list.
   */
  const toCandidates = (playerIds: readonly unknown[]): LineupCandidate[] =>
    playerIds.flatMap((id) => {
      const projection = artifact.players[String(id)];
      if (projection === undefined || !projection.active) return [];
      const position = projection.position as Position;
      return [
        {
          playerId: asPlayerId(String(id)),
          position,
          eligiblePositions: [position],
          projectedPoints: scoreFor(projection, snapshot.league.scoring.raw),
          stddev: projection.sd,
        },
      ];
    });

  const analyses = analyzeRosters(
    snapshot.rosters.map((roster) => ({
      teamId: roster.teamId,
      candidates: toCandidates(roster.playerIds),
    })),
    snapshot.league.rosterSlots,
  );

  const partners = rankPartners(analyses, teamId).slice(0, 5).map((fit) => ({
    ...fit,
    offers: offerCandidates(analyses, teamId, fit.partnerTeamId)
      .slice(0, 4)
      .map((offer) => ({
        playerId: String(offer.playerId),
        name: artifact.players[String(offer.playerId)]?.name ?? String(offer.playerId),
        position: offer.position,
        projected: offer.projected,
        helpsThemBy: offer.helpsThemBy,
      })),
  }));

  const marginalDetail = marginal
    .map((entry) => {
      const id = String(entry.playerId);
      const projection = artifact.players[id];
      return {
        playerId: id,
        name: projection?.name ?? id,
        position: entry.position,
        marginal: entry.marginal,
        projected: entry.projected,
        value: values.get(id)?.value ?? 0,
      };
    })
    .sort((a, b) => a.marginal - b.marginal);

  /*
   * Market values are the only hard requirement.
   *
   * Fairness decides whether a proposal is plausible, and without values there
   * is nothing to judge. Needs and surplus are different: a heuristic for
   * narrowing the search. Treating them as preconditions meant a balanced
   * roster — the normal case — got an empty page that read as "there are no
   * good trades" when in fact nothing had been searched.
   */
  if (values.size === 0) {
    return {
      evaluations: [],
      needs,
      surplus,
      valuesAvailable: values.size > 0,
      depth,
      partners,
      marginal: marginalDetail,
    };
  }

  // Screen cheaply, then re-simulate the survivors precisely — the same
  // two-stage shape the waiver page uses.
  /*
   * Ages, so a rebuild can tell a 22-year-old from a 30-year-old. Derived from
   * the crosswalk's birthdates; a player without one is treated as prime rather
   * than guessed at, so a missing date cannot pass for youth.
   */
  const identities = await loadIdentities();
  const ages = new Map<string, number>();
  for (const [id, identity] of Object.entries(identities)) {
    if (identity.birthdate === null) continue;
    const born = Date.parse(identity.birthdate);
    if (Number.isNaN(born)) continue;
    ages.set(id, (Date.now() - born) / (365.25 * 24 * 60 * 60 * 1000));
  }

  const targeting = {
    ...(query.objective !== undefined ? { objective: query.objective } : {}),
    ...(query.targetPlayerId != null
      ? { targetPlayerIds: [asPlayerId(query.targetPlayerId)] }
      : {}),
    ...(query.targetPosition != null
      ? { targetPositions: [query.targetPosition as Position] }
      : {}),
    ages,
  };

  const screened = findTrades({
    context: { ...context, iterations: SCREEN_ITERATIONS },
    myTeamId: teamId,
    assetsByTeam,
    needs,
    surplus,
    finalists: 6,
    ...targeting,
  });

  const evaluations = screened
    .slice(0, FINALIST_COUNT)
    .map((candidate) =>
      findTrades({
        context: { ...context, iterations: FINALIST_ITERATIONS },
        myTeamId: teamId,
        assetsByTeam: new Map([
          [teamId, candidate.sideA.sends],
          [candidate.sideB.teamId, candidate.sideB.sends],
        ]),
        needs,
        surplus,
        finalists: 1,
        ...targeting,
      }),
    )
    .flat();

  return {
    evaluations,
    needs,
    surplus,
    valuesAvailable: true,
    depth,
    partners,
    marginal: marginalDetail,
  };
};
