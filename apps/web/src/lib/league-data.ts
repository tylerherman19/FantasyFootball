import { SleeperAdapter } from '@ffe/adapters';
import {
  asPlayerId,
  lineupEfficiencies,
  type Position,
  currentOdds,
  simulateSeason,
  projectSeason,
  seedFrom,
  type LeagueSnapshot,
  type SeasonSimResult,
  type SimContext,
  type TeamContext,
} from '@ffe/core';
import { loadIdentities } from './crosswalk';
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
  readonly efficiencies: ReadonlyMap<string, import('@ffe/core').EfficiencyResult>;
}

export const listLeagues = async (username: string, season: number) =>
  adapter.listLeagues(username, season);

const FORMAT_LABEL: Record<string, string> = {
  dynasty: 'Dynasty',
  keeper: 'Keeper',
  redraft: 'Redraft',
  guillotine: 'Guillotine',
};

/**
 * The starting lineup, spelled out.
 *
 * "2QB" and "superflex" are different leagues that reward different rosters, and
 * a tool that silently confuses them will give bad advice with total confidence.
 * Showing the parsed slots makes the detection auditable at a glance rather than
 * something the user has to trust.
 */
export const lineupShape = (snapshot: LeagueSnapshot): string => {
  const counts = new Map<string, number>();
  for (const slot of snapshot.league.rosterSlots) {
    if (slot === 'BN' || slot === 'IR' || slot === 'TAXI') continue;
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }

  const order = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'WRRB_FLEX', 'REC_FLEX', 'SUPER_FLEX', 'K', 'DEF', 'DL', 'LB', 'DB', 'IDP_FLEX'];

  return [...counts.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([slot, count]) => (count > 1 ? `${count}${slot}` : slot))
    .join(' · ');
};

/** How many quarterbacks can start at once — the single biggest driver of QB value. */
export const startableQbs = (snapshot: LeagueSnapshot): number =>
  snapshot.league.rosterSlots.filter((slot) => slot === 'QB' || slot === 'SUPER_FLEX').length;

/** One-line league description used in the header of every league page. */
export const leagueMeta = (snapshot: LeagueSnapshot): string => {
  const qbs = startableQbs(snapshot);

  return [
    FORMAT_LABEL[snapshot.league.format] ?? snapshot.league.format,
    `${snapshot.league.teamCount} teams`,
    // Name the format the way managers do: superflex if a flex accepts a QB,
    // 2QB if two dedicated QB slots, otherwise nothing worth saying.
    snapshot.league.superFlex ? 'superflex' : qbs > 1 ? `${qbs}QB` : null,
    snapshot.league.medianWins ? 'median wins' : null,
    `week ${snapshot.asOfWeek}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
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
  // Every league scores its own way — 42, 64 and 132 keys across Tyler's three.
  const rules = snapshot.league.scoring.raw;
  const pool = artifact === null ? new Map() : buildPool(artifact, weeks, rules);

  // Measured from what each manager actually did, not assumed. Falls back to
  // this league's own average until a manager has enough played weeks.
  const identities = await loadIdentities();
  const efficiencies = lineupEfficiencies(snapshot, (playerId) => {
    const position = identities[String(playerId)]?.position;
    return (position ?? null) as Position | null;
  });

  const teams: TeamContext[] = snapshot.rosters.map((roster) => ({
    teamId: roster.teamId,
    playerIds: roster.playerIds.map((id) => asPlayerId(String(id))),
    rosterSlots: snapshot.league.rosterSlots,
    lineupEfficiency: efficiencies.get(roster.teamId)?.efficiency ?? 0.93,
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

  // Match on the platform account id, not the display name. Display names differ
  // between leagues and change mid-season; matching on them silently fails to
  // find your own team, which reads as "you are not in this league".
  const myUserId = await adapter.resolveUserId(username);
  const me =
    snapshot.managers.find((m) => m.platformUserId === myUserId) ??
    snapshot.managers.find((m) => m.coOwnerUserIds.includes(myUserId)) ??
    snapshot.managers.find((m) => m.displayName.toLowerCase() === username.toLowerCase());

  return {
    snapshot,
    context,
    result,
    teamNames,
    myTeamId: me?.id ?? null,
    modelVersion: artifact?.modelVersion ?? null,
    generatedAt: artifact?.generatedAt ?? null,
    efficiencies,
  };
};

export { currentOdds };
