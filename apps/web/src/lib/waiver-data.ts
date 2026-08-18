import {
  asPlayerId,
  estimateFutureGain,
  rankWaivers,
  type PlayerId,
  type WaiverRecommendation,
} from '@ffe/core';
import { loadArtifact, scoreFor, type ArtifactPlayer } from './projections';
import type { LeagueView } from './league-data';

/**
 * Waiver analysis for one team.
 *
 * Ranking every free agent by full simulation is not affordable — 800 players
 * times two simulations times thousands of iterations. It is also unnecessary:
 * the vast majority of the wire cannot crack any lineup, and a player who can't
 * start can't change your odds.
 *
 * So the same pipeline the trade finder uses applies here: cheap filter first,
 * expensive simulation only on plausible candidates.
 */

/** How many free agents survive the cheap filter and get screened. */
const SCREEN_TOP = 24;

/** Coarse pass: enough iterations to separate real help from noise, no more. */
const SCREEN_ITERATIONS = 400;

/** Finalists re-simulated precisely, since these are the numbers on screen. */
const FINALIST_COUNT = 8;
const FINALIST_ITERATIONS = 4_000;

export interface WaiverView {
  readonly recommendations: readonly WaiverRecommendation[];
  readonly candidateCount: number;
  readonly simulatedCount: number;
  readonly remainingBudget: number;
  readonly seasonBudget: number;
}

export const loadWaivers = async (view: LeagueView, teamId: string): Promise<WaiverView | null> => {
  const { snapshot, context } = view;

  const artifact = await loadArtifact(snapshot.league.season, snapshot.asOfWeek);
  if (artifact === null) return null;

  const rules = snapshot.league.scoring.raw;

  const rostered = new Set<string>();
  for (const roster of snapshot.rosters) {
    for (const playerId of roster.playerIds) rostered.add(String(playerId));
  }

  const freeAgents = Object.values(artifact.players)
    .filter((player: ArtifactPlayer) => !rostered.has(player.playerId) && player.active)
    .sort((a, b) => scoreFor(b, rules) - scoreFor(a, rules));

  // Cheap filter: only players projected well enough to plausibly start.
  const candidates = freeAgents.slice(0, SCREEN_TOP);

  const myRoster = snapshot.rosters.find((r) => r.teamId === teamId);
  const myPlayers = myRoster?.playerIds ?? [];

  // Droppables: our own worst projected players. Dropping a starter to add a
  // slightly better bench piece is usually negative, and the simulation will
  // say so — but there's no reason to spend iterations proving it.
  const projections = artifact.players;
  const droppable = [...myPlayers]
    .map((id) => {
      const player = projections[String(id)];
      return { id: String(id), mean: player === undefined ? 0 : scoreFor(player, rules) };
    })
    .sort((a, b) => a.mean - b.mean)
    .slice(0, 3)
    .map((p) => asPlayerId(p.id) as PlayerId);

  const weeksRemaining = Math.max(1, snapshot.league.regularSeasonWeeks - snapshot.asOfWeek + 1);

  /**
   * Real remaining budget, not an assumed hundred dollars.
   *
   * The season allowance comes from the league's own settings, and everything
   * this team has already spent on waivers is subtracted from it. A manager with
   * $12 left should not be told to bid $40.
   */
  const spent = snapshot.transactions
    .filter((transaction) => transaction.kind === 'waiver')
    .reduce((total, transaction) => total + (transaction.faabSpent[teamId] ?? 0), 0);

  const remainingBudget = Math.max(0, snapshot.league.waiverBudget - spent);

  const toCandidate = (player: ArtifactPlayer) => ({
    playerId: asPlayerId(player.playerId),
    name: player.name,
    position: player.position,
  });

  const shared = {
    teamId,
    dropCandidates: droppable,
    remainingBudget,
    weeksRemaining,
  };

  // Stage one: coarse screen. Cheap iterations are plenty to tell "helps" from
  // "doesn't", which is all this pass has to decide.
  const screened = rankWaivers({
    ...shared,
    context: { ...context, iterations: SCREEN_ITERATIONS },
    candidates: candidates.map(toCandidate),
  });

  const finalistIds = new Set(
    screened
      .filter((r) => r.delta.titleDelta > 0)
      .slice(0, FINALIST_COUNT)
      .map((r) => String(r.candidate.playerId)),
  );

  // Price future opportunity off the *full* screened field. Deriving it from the
  // finalists alone would make a thin finalist round look like a barren wire and
  // inflate every bid.
  const expectedFutureGain = estimateFutureGain(
    screened.map((r) => r.delta.titleDelta),
    weeksRemaining,
  );

  // Stage two: the survivors get simulated properly, because these are the
  // numbers a manager will actually act on.
  const recommendations = rankWaivers({
    ...shared,
    context: { ...context, iterations: FINALIST_ITERATIONS },
    expectedFutureGain,
    candidates: candidates.filter((p) => finalistIds.has(p.playerId)).map(toCandidate),
  });

  return {
    recommendations: recommendations.filter((r) => r.delta.titleDelta > 0),
    candidateCount: freeAgents.length,
    simulatedCount: candidates.length,
    remainingBudget,
    seasonBudget: snapshot.league.waiverBudget,
  };
};
