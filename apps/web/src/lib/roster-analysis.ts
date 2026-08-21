import {
  analyzeRosters,
  asPlayerId,
  type DepthAssessment,
  type LineupCandidate,
  type Position,
} from '@ffe/core';
import { loadAvailability } from './availability';
import { loadIdentities } from './crosswalk';
import type { LeagueView } from './league-data';
import { isPlayingIn, loadArtifact, scoreFor } from './projections';
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
  /** Sell candidates: expendable here, valued by the market. */
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
    loadMarketValues(snapshot.league.format, snapshot.league.superFlex),
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

  const players: RosterPlayer[] = analysis.marginal.map((entry) => {
    const id = String(entry.playerId);
    const projection = artifact.players[id];
    const identity = identities[id];
    const marketValue = values.get(id)?.value ?? 0;

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

  // Sell: the market pays for him, the lineup doesn't need him.
  const sellCandidates = players
    .filter((p) => p.marginal < 1 && p.marketValue > 0)
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
