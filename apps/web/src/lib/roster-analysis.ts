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
import type { LeagueView } from './league-data';
import { isPlayingIn, loadArtifact, scoreFor } from './projections';
import { loadExplanation } from './projections';
import { projectionConfidence } from './explain';
import { loadEdgePlayerValues } from './edge-values';

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
  readonly value: number;
  /** Rank among all priced players league-wide, 1 = most valuable. */
  readonly overallRank: number | null;
  readonly injuryStatus: string | null;
  /**
   * Model value per point of lineup contribution.
   *
   * High means the price reflects more than what he does for this roster —
   * longevity, name-independent future production — a sell candidate. Low
   * means the reverse: he is worth more here than his price says, so keep him.
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

export const analyzeRoster = async (
  view: LeagueView,
  teamId: string,
): Promise<RosterAnalysis | null> => {
  const { snapshot } = view;

  const [artifact, values, identities, availability] = await Promise.all([
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadEdgePlayerValues(snapshot.league, snapshot.league.season, snapshot.asOfWeek),
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
    const valuation = values.get(id);
    const value = valuation?.value ?? 0;
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
      value,
      overallRank: valuation?.overallRank ?? null,
      injuryStatus: availability[id]?.injuryStatus ?? null,
      valuePerPoint: value > 0 && entry.marginal > 0.5 ? value / entry.marginal : null,
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
  // "High value" is relative to this league, not a constant on a feed's old
  // scale: a core asset is one of the first four rounds' worth of players, or
  // already a genuine weekly starter.
  const coreCutoff = snapshot.league.teamCount * 4;
  const isYoungCoreAsset = (p: RosterPlayer): boolean =>
    p.age !== null &&
    p.age <= 25 &&
    ((p.overallRank !== null && p.overallRank <= coreCutoff) || p.projected >= 12);

  const sellCandidates = players
    .filter(
      (p) =>
        isExpendable(p) &&
        !isYoungCoreAsset(p) &&
        p.value > 0 &&
        p.modelConfidence >= 0.45,
    )
    .sort((a, b) => b.value - a.value)
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
