import type { LineupSlot, PlayerId, Position } from '../domain/index.js';
import { assessDepth, marginalValues, type DepthAssessment, type MarginalValue } from '../metrics/marginal-value.js';
import type { LineupCandidate } from '../sim/lineup.js';

/**
 * League-wide trade fit.
 *
 * A good proposal is not "a player I can spare for a player I want" — that is
 * half the problem, and it is the half that produces offers nobody accepts. The
 * other half is *their* roster: a trade only happens when the piece you are
 * offering is worth more to them than what they are giving up.
 *
 * So every team gets the same counterfactual analysis: what does each of their
 * players actually contribute to their own optimal lineup, where are they thin,
 * and what are they carrying that they do not use. Matching your surplus to
 * their thinness — measured on both sides, in points, from the same projections
 * — is what makes a proposal realistic rather than wishful.
 *
 * This is the piece that turns a trade calculator into a trade finder.
 */

export interface TeamRosterAnalysis {
  readonly teamId: string;
  readonly marginal: readonly (MarginalValue & { position: Position })[];
  readonly depth: readonly DepthAssessment[];
  /** Positions where losing the top player would gut the lineup. */
  readonly thin: readonly Position[];
  /** Positions holding players whose exit costs nothing. */
  readonly surplus: readonly Position[];
  /** Total projected points of the optimal lineup — overall roster strength. */
  readonly lineupStrength: number;
}

export interface RosterInput {
  readonly teamId: string;
  readonly candidates: readonly LineupCandidate[];
}

export const analyzeRosters = (
  rosters: readonly RosterInput[],
  rosterSlots: readonly LineupSlot[],
): Map<string, TeamRosterAnalysis> => {
  const out = new Map<string, TeamRosterAnalysis>();

  for (const roster of rosters) {
    const positionById = new Map(roster.candidates.map((c) => [String(c.playerId), c.position]));

    const marginal = marginalValues(roster.candidates, rosterSlots).map((value) => ({
      ...value,
      position: (positionById.get(String(value.playerId)) ?? 'WR') as Position,
    }));

    const depth = assessDepth(marginal);

    out.set(roster.teamId, {
      teamId: roster.teamId,
      marginal,
      depth,
      thin: depth.filter((d) => d.verdict === 'thin').map((d) => d.position as Position),
      surplus: depth.filter((d) => d.verdict === 'surplus').map((d) => d.position as Position),
      lineupStrength: marginal.reduce((sum, m) => sum + (m.starting ? m.projected : 0), 0),
    });
  }

  return out;
};

export interface FitScore {
  readonly partnerTeamId: string;
  /** Positions I am thin at where they have genuine surplus. */
  readonly theyCanHelp: readonly Position[];
  /** Positions they are thin at where I have surplus. */
  readonly iCanHelp: readonly Position[];
  /**
   * How complementary the two rosters are, 0 upward.
   *
   * Both directions matter: a partner who needs nothing I have will not trade
   * regardless of how badly I need their player.
   */
  readonly mutualFit: number;
  readonly reason: string;
}

/**
 * Rank potential partners by how well the two rosters complement each other.
 *
 * Scored in points rather than counts — being thin at running back by eight
 * points is a very different conversation from being thin by one.
 */
export const rankPartners = (
  analyses: ReadonlyMap<string, TeamRosterAnalysis>,
  myTeamId: string,
): FitScore[] => {
  const mine = analyses.get(myTeamId);
  if (mine === undefined) return [];

  const exposureByPosition = (analysis: TeamRosterAnalysis): Map<string, number> =>
    new Map(analysis.depth.map((d) => [d.position, d.exposureToTopLoss]));

  const surplusPointsByPosition = (analysis: TeamRosterAnalysis): Map<string, number> => {
    const out = new Map<string, number>();
    for (const player of analysis.marginal) {
      if (player.marginal >= 1) continue;
      // A spare player's worth to someone else is what he would actually
      // produce, not what he adds here — which is nothing.
      out.set(player.position, Math.max(out.get(player.position) ?? 0, player.projected));
    }
    return out;
  };

  const myExposure = exposureByPosition(mine);
  const mySurplus = surplusPointsByPosition(mine);

  const scores: FitScore[] = [];

  for (const [teamId, theirs] of analyses) {
    if (teamId === myTeamId) continue;

    const theirSurplus = surplusPointsByPosition(theirs);
    const theirExposure = exposureByPosition(theirs);

    const theyCanHelp: Position[] = [];
    const iCanHelp: Position[] = [];
    let score = 0;

    for (const position of mine.thin) {
      const available = theirSurplus.get(position) ?? 0;
      if (available <= 0) continue;
      theyCanHelp.push(position);
      // How much of my exposure their spare part could cover.
      score += Math.min(available, myExposure.get(position) ?? 0);
    }

    for (const position of theirs.thin) {
      const available = mySurplus.get(position) ?? 0;
      if (available <= 0) continue;
      iCanHelp.push(position);
      score += Math.min(available, theirExposure.get(position) ?? 0);
    }

    if (score <= 0) continue;

    const reason =
      theyCanHelp.length > 0 && iCanHelp.length > 0
        ? `They have spare ${theyCanHelp.join('/')}, you have spare ${iCanHelp.join('/')} — both sides fill a real hole.`
        : theyCanHelp.length > 0
          ? `They can spare ${theyCanHelp.join('/')} where you are thin, but need little you have spare.`
          : `You can spare ${iCanHelp.join('/')} where they are thin — leverage, if you want something back.`;

    scores.push({
      partnerTeamId: teamId,
      theyCanHelp,
      iCanHelp,
      // Two-way fit is worth more than one-way, because it is what actually
      // gets accepted.
      mutualFit: theyCanHelp.length > 0 && iCanHelp.length > 0 ? score * 1.5 : score,
      reason,
    });
  }

  return scores.sort((a, b) => b.mutualFit - a.mutualFit);
};

/**
 * Players worth offering to a specific partner: spare here, useful there.
 *
 * Returns pairs of (my player, their need) sorted by how much the move would
 * help them — because a proposal they want is a proposal that happens.
 */
export const offerCandidates = (
  analyses: ReadonlyMap<string, TeamRosterAnalysis>,
  myTeamId: string,
  partnerTeamId: string,
): { playerId: PlayerId; position: Position; projected: number; helpsThemBy: number }[] => {
  const mine = analyses.get(myTeamId);
  const theirs = analyses.get(partnerTeamId);
  if (mine === undefined || theirs === undefined) return [];

  const theirExposure = new Map(theirs.depth.map((d) => [d.position, d.exposureToTopLoss]));

  return mine.marginal
    .filter((player) => player.marginal < 1)
    .map((player) => ({
      playerId: player.playerId,
      position: player.position,
      projected: player.projected,
      helpsThemBy: Math.min(player.projected, theirExposure.get(player.position) ?? 0),
    }))
    .filter((offer) => offer.helpsThemBy > 0)
    .sort((a, b) => b.helpsThemBy - a.helpsThemBy);
};
