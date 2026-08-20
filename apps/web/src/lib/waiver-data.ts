import {
  asPlayerId,
  estimateFutureGain,
  rankWaivers,
  starterPoints,
  withRosterChange,
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

  // Priority leagues have no bid to make, so the budget is reported as zero and
  // the UI says "waiver priority" rather than inventing a dollar figure.
  const isFaab = snapshot.league.waiverType === 'faab';
  const remainingBudget = isFaab ? Math.max(0, snapshot.league.waiverBudget - spent) : 0;

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

  /*
   * Take the best of the screen, whatever its sign.
   *
   * Requiring a positive title delta here threw away the entire wire in the
   * preseason and most weeks besides: at 400 iterations the odds change from
   * adding a fourth receiver is far below what the screen can resolve, so the
   * sign is close to a coin flip and the finalist round came back empty. The
   * screen's job is ordering, not judgement.
   */
  const finalistIds = new Set(
    screened.slice(0, FINALIST_COUNT).map((r) => String(r.candidate.playerId)),
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
    // Ranked, not filtered. A wire where the best add is worth +0.1% is a
    // finding a manager can act on — it says save the FAAB. An empty list says
    // the tool is broken, which is what this page used to say every week.
    recommendations,
    candidateCount: freeAgents.length,
    simulatedCount: candidates.length,
    remainingBudget,
    seasonBudget: isFaab ? snapshot.league.waiverBudget : 0,
  };
};


/**
 * Best available free agents, ready to ship to the browser.
 *
 * Filtered hard on purpose: the vast majority of any wire cannot crack a lineup,
 * and a player who cannot start cannot change your odds. Simulating them would
 * cost time to prove a foregone conclusion.
 */
export const loadFreeAgents = async (view: LeagueView, teamId: string | null) => {
  const { snapshot, context } = view;
  const artifact = await loadArtifact(snapshot.league.season, snapshot.asOfWeek);
  if (artifact === null) return [];

  const rules = snapshot.league.scoring.raw;

  const rostered = new Set<string>();
  for (const roster of snapshot.rosters) {
    for (const id of roster.playerIds) rostered.add(String(id));
  }

  const available = Object.values(artifact.players)
    .filter((player) => !rostered.has(player.playerId) && player.active)
    .map((player) => ({
      id: player.playerId,
      name: player.name,
      position: player.position,
      team: player.team,
      mean: scoreFor(player, rules),
      sd: player.sd,
      gameId: player.gameId,
      gameLoading: player.gameLoading,
      active: player.active,
      value: 0,
      // Everyone here came out of the projection artifact by definition.
      projected: true,
    }));

  const team = teamId === null ? undefined : context.teams.find((t) => t.teamId === teamId);

  /*
   * Rank by what a player adds to *this* lineup, not by raw projected points.
   *
   * Ranking on raw points is why the wire read as nonsense: in a superflex
   * league every rosterable quarterback out-projects every available receiver,
   * so the board filled with backup and retired quarterbacks who could never
   * crack a lineup already starting two better ones. The counterfactual — how
   * much the optimal lineup gains by adding this player — is replacement-aware
   * by construction, and it prices a third quarterback at approximately zero,
   * which is what he is worth.
   *
   * Scored on the first remaining week: one lineup solve per free agent.
   */
  if (team === undefined) {
    return available.sort((a, b) => b.mean - a.mean).slice(0, SCREEN_TOP);
  }

  const week = context.weeks.slice(0, 1);
  const base = starterPoints(team, context.pool, week);

  return available
    .map((player) => ({
      player,
      gain:
        starterPoints(
          withRosterChange(team, { add: [asPlayerId(player.id)] }),
          context.pool,
          week,
        ) - base,
    }))
    // Ties on zero gain are broken by raw projection, so the most useful of the
    // unusable options still sorts to the top of that group.
    .sort((a, b) => b.gain - a.gain || b.player.mean - a.player.mean)
    .slice(0, SCREEN_TOP)
    .map((entry) => entry.player);
};

/** Remaining FAAB for one team, or zeroes in a priority league. */
export const waiverBudgetFor = (
  snapshot: LeagueView['snapshot'],
  teamId: string,
): { remainingBudget: number; seasonBudget: number } => {
  if (snapshot.league.waiverType !== 'faab') return { remainingBudget: 0, seasonBudget: 0 };

  const spent = snapshot.transactions
    .filter((transaction) => transaction.kind === 'waiver')
    .reduce((total, transaction) => total + (transaction.faabSpent[teamId] ?? 0), 0);

  return {
    remainingBudget: Math.max(0, snapshot.league.waiverBudget - spent),
    seasonBudget: snapshot.league.waiverBudget,
  };
};
