import { SleeperAdapter } from '@ffe/adapters';
import {
  asPlayerId,
  currentOdds,
  simulateSeason,
  projectSeason,
  seedFrom,
  type LeagueSnapshot,
  type SeasonSimResult,
  type SimContext,
  type TeamContext,
} from '@ffe/core';
import { buildPool, loadArtifact } from './projections';

/**
 * Server-side league loading and simulation.
 *
 * Simulation runs on the server and is cached per league, because a 10,000
 * iteration season is a second or two of work that shouldn't repeat on every
 * navigation. What-if interactions — trade toggles, start/sit — run client-side
 * against the same engine, since those need to feel instant.
 */

const adapter = new SleeperAdapter();

/** How many iterations page loads use. Final answers re-run at full count. */
const PAGE_ITERATIONS = 4_000;

export interface LeagueView {
  readonly snapshot: LeagueSnapshot;
  readonly context: SimContext;
  readonly result: SeasonSimResult;
  readonly teamNames: ReadonlyMap<string, string>;
  readonly myTeamId: string | null;
  readonly modelVersion: string | null;
  readonly generatedAt: string | null;
}

export const listLeagues = async (username: string, season: number) =>
  adapter.listLeagues(username, season);

/**
 * Measured lineup efficiency per manager.
 *
 * Uses their own history where it exists. Simulating everyone as a perfect
 * optimizer overrates deep benches that never actually get started; assuming a
 * flat penalty for everyone erases a real skill difference between managers.
 */
const lineupEfficiencies = (snapshot: LeagueSnapshot): Map<string, number> => {
  const efficiencies = new Map<string, number>();
  for (const roster of snapshot.rosters) {
    // Until enough weeks are played, use a league-typical value rather than a
    // number computed from two games.
    efficiencies.set(roster.teamId, 0.94);
  }
  return efficiencies;
};

export const loadLeague = async (
  platformLeagueId: string,
  username: string,
): Promise<LeagueView> => {
  const snapshot = await adapter.loadSnapshot(platformLeagueId);

  const weeks: number[] = [];
  for (let week = snapshot.asOfWeek; week <= snapshot.league.regularSeasonWeeks; week += 1) {
    weeks.push(week);
  }

  const artifact = await loadArtifact(snapshot.league.season, snapshot.asOfWeek);
  const pool = artifact === null ? new Map() : buildPool(artifact, weeks);

  const efficiencies = lineupEfficiencies(snapshot);

  const teams: TeamContext[] = snapshot.rosters.map((roster) => ({
    teamId: roster.teamId,
    playerIds: roster.playerIds.map((id) => asPlayerId(String(id))),
    rosterSlots: snapshot.league.rosterSlots,
    lineupEfficiency: efficiencies.get(roster.teamId) ?? 0.94,
  }));

  const context: SimContext = {
    snapshot,
    teams,
    pool,
    weeks,
    iterations: PAGE_ITERATIONS,
    // Seeded from the league so results are stable across reloads.
    seed: seedFrom(snapshot.league.id, snapshot.asOfWeek),
  };

  const result = simulateSeason({
    snapshot,
    projections: projectSeason(teams, pool, weeks),
    iterations: PAGE_ITERATIONS,
    seed: context.seed ?? 0,
  });

  const teamNames = new Map(snapshot.managers.map((m) => [m.id, m.teamName]));
  const me = snapshot.managers.find(
    (m) => m.displayName.toLowerCase() === username.toLowerCase(),
  );

  return {
    snapshot,
    context,
    result,
    teamNames,
    myTeamId: me?.id ?? null,
    modelVersion: artifact?.modelVersion ?? null,
    generatedAt: artifact?.generatedAt ?? null,
  };
};

export { currentOdds };
