import {
  analyzeRosters,
  asPlayerId,
  evaluatePlayer,
  isExpendable,
  predictionQuantiles,
  type DepthAssessment,
  type LineupCandidate,
  type Position,
} from '@ffe/core';
import { loadAvailability } from './availability';
import { loadIdentities } from './crosswalk';
import { derived, type LeagueView } from './league-data';
import { isPlayingIn, loadArtifact, scoreFor } from './projections';
import { loadExplanation } from './projections';
import { projectionConfidence } from './explain';
import { loadMarketValues } from './values';

/**
 * Everything the roster page needs, computed once.
 *
 * The page answers four questions a manager actually has — who is carrying this
 * team, who can I move, where am I exposed, and is this roster built for now or
 * later — and each is a different view of the same underlying counterfactual.
 */

export interface RosterPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly age: number | null;
  readonly projected: number;
  readonly sd: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly modelConfidence: number;
  /** Evidence- and risk-adjusted points used for decision ranking. */
  readonly decisionPoints: number;
  /** Points the optimal lineup loses without this player. */
  readonly marginal: number;
  readonly starting: boolean;
  readonly marketValue: number;
  readonly injuryStatus: string | null;
  /**
   * Market value per point of lineup contribution.
   *
   * High means the market prices him well above what he does for this roster —
   * a sell candidate. Low means the reverse: he is worth more here than the
   * market would pay, so keep him.
   */
  readonly valuePerPoint: number | null;
}

export interface RosterAnalysis {
  readonly players: readonly RosterPlayer[];
  readonly depth: readonly DepthAssessment[];
  readonly lineupTotal: number;
  /**
   * Share of the lineup's points that come from the top two players.
   *
   * The fragility measure: a team leaning heavily on two players is one injury
   * from collapse regardless of how good its record looks.
   */
  readonly topTwoShare: number;
  readonly averageStarterAge: number | null;
  /** Trade-away candidates: non-starters with a real replacement and market value. */
  readonly sellCandidates: readonly RosterPlayer[];
  /** Keepers: worth more to this lineup than the market would pay. */
  readonly undervalued: readonly RosterPlayer[];
}

const computeRosterAnalysis = async (
  view: LeagueView,
  teamId: string,
): Promise<RosterAnalysis | null> => {
  const { snapshot } = view;

  const [artifact, values, identities, availability] = await Promise.all([
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadMarketValues(snapshot),
    loadIdentities(),
    loadAvailability(),
  ]);

  if (artifact === null) return null;

  const rules = snapshot.league.scoring.raw;
  const roster = snapshot.rosters.find((r) => r.teamId === teamId);
  if (roster === undefined) return null;

  const candidates: LineupCandidate[] = roster.playerIds.flatMap((id) => {
    const projection = artifact.players[String(id)];
    if (projection === undefined || !isPlayingIn(projection, snapshot.asOfWeek)) return [];

    const position = projection.position as Position;
    const status = availability[String(id)]?.injuryStatus ?? null;

    return [
      {
        playerId: asPlayerId(String(id)),
        position,
        eligiblePositions: [position],
        projectedPoints: scoreFor(projection, rules, status, snapshot.asOfWeek),
        stddev: projection.sd,
      },
    ];
  });

  const analyses = analyzeRosters([{ teamId, candidates }], snapshot.league.rosterSlots);
  const analysis = analyses.get(teamId);
  if (analysis === undefined) return null;

  const explanationEntries = await Promise.all(
    roster.playerIds.map(
      async (id) => [
        String(id),
        await loadExplanation(snapshot.league.season, snapshot.asOfWeek, String(id)),
      ] as const,
    ),
  );
  const explanations = new Map(explanationEntries);

  const players: RosterPlayer[] = analysis.marginal.map((entry) => {
    const id = String(entry.playerId);
    const projection = artifact.players[id];
    const identity = identities[id];
    const marketValue = values.get(id)?.value ?? 0;
    const weekly = view.context.pool.get(snapshot.asOfWeek)?.get(asPlayerId(id));
    const quantiles =
      weekly?.p25 === undefined || weekly.p50 === undefined || weekly.p75 === undefined
        ? predictionQuantiles(entry.projected, projection?.sd ?? 0)
        : { p25: weekly.p25, p50: weekly.p50, p75: weekly.p75 };
    const why = explanations.get(id);
    const modelConfidence =
      why === undefined
        ? projection?.basis === 'rookie-prior'
          ? 0.25
          : 0.5
        : projectionConfidence(
            why.effectiveGames,
            projection?.basis === 'rookie-prior' || why.prior === undefined,
          );
    const decision = evaluatePlayer({
      projectedPoints: entry.projected,
      sd: projection?.sd ?? 0,
      confidence: modelConfidence,
      quantiles,
      replacementPoints: entry.replacedBy,
      objective: 'balanced',
    });

    // Age comes from the crosswalk's birthdate, the only place it reliably
    // exists for every rostered player.
    const birthdate = identity?.birthdate ?? null;
    const age =
      birthdate === null
        ? null
        : (Date.now() - new Date(birthdate).getTime()) / (365.25 * 24 * 3600 * 1000);

    return {
      playerId: id,
      name: projection?.name ?? identity?.name ?? id,
      position: entry.position,
      team: projection?.team ?? identity?.team ?? '',
      age: age === null || !Number.isFinite(age) ? null : age,
      projected: entry.projected,
      sd: projection?.sd ?? 0,
      ...quantiles,
      modelConfidence,
      decisionPoints: decision.evidenceAdjustedPoints,
      marginal: entry.marginal,
      starting: entry.starting,
      marketValue,
      injuryStatus: availability[id]?.injuryStatus ?? null,
      valuePerPoint: marketValue > 0 && entry.marginal > 0.5 ? marketValue / entry.marginal : null,
    };
  });

  const starters = players.filter((p) => p.starting).sort((a, b) => b.projected - a.projected);
  const lineupTotal = starters.reduce((sum, p) => sum + p.projected, 0);
  const topTwo = starters.slice(0, 2).reduce((sum, p) => sum + p.projected, 0);

  const agedStarters = starters.filter((p) => p.age !== null);
  const averageStarterAge =
    agedStarters.length === 0
      ? null
      : agedStarters.reduce((sum, p) => sum + (p.age ?? 0), 0) / agedStarters.length;

  // Trade-away: use the same canonical expendability rule as the trade engine.
  // A low marginal number on its own is not a sell signal: it can describe a
  // starter whose slot is duplicated by another player, which is exactly how an
  // elite current starter could otherwise be mislabelled.
  // Young, high-value/upside assets are also not automatic move suggestions:
  // being replaceable today does not mean the dynasty asset should be sold.
  //
  // The bar is a share of the league's best asset rather than a fixed 6,000.
  // That constant was calibrated against a feed whose scale we no longer use,
  // and an absolute threshold on a normalised index means something different
  // in a shallow league than in a deep one — which is exactly the kind of quiet
  // miscalibration that produces a confident bad sell recommendation.
  const topValue = Math.max(...players.map((p) => p.marketValue), 1);
  const isYoungCoreAsset = (p: RosterPlayer): boolean =>
    p.age !== null &&
    p.age <= 25 &&
    (p.marketValue >= topValue * 0.6 || p.projected >= 12);

  const sellCandidates = players
    .filter(
      (p) =>
        isExpendable(p) &&
        !isYoungCoreAsset(p) &&
        p.marketValue > 0 &&
        p.modelConfidence >= 0.45,
    )
    .sort((a, b) => b.marketValue - a.marketValue)
    .slice(0, 5);

  // Keep: he carries the lineup for less than the market would charge.
  const undervalued = players
    .filter((p) => p.valuePerPoint !== null && p.marginal >= 1)
    .sort((a, b) => (a.valuePerPoint ?? 0) - (b.valuePerPoint ?? 0))
    .slice(0, 5);

  return {
    players: players.sort((a, b) => b.marginal - a.marginal || b.projected - a.projected),
    depth: analysis.depth,
    lineupTotal,
    topTwoShare: lineupTotal > 0 ? topTwo / lineupTotal : 0,
    averageStarterAge,
    sellCandidates,
    undervalued,
  };
};

/**
 * One team's roster read, cached per league state and team.
 *
 * Every candidate's marginal value is a separate lineup solve, so this is
 * quadratic in roster size — and the roster page, the trade page and the team
 * page all want it for the same team.
 */
export const analyzeRoster = derived('roster-analysis', computeRosterAnalysis, (teamId: string) => teamId);
