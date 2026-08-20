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
import { loadAvailability } from './availability';
import { ttlCache } from './cache';
import { loadIdentities } from './crosswalk';
import { buildPool, loadArtifact } from './projections';

/**
 * Server-side league loading and simulation.
 *
 * Simulation runs on the server and is cached per league, because a 10,000
 * iteration season is a second or two of work that shouldn't repeat on every
 * navigation. What-if interactions — trade toggles, start/sit — run client-side
 * against the same engine, since those need to feel instant.
 *
 * The cache is keyed by league and viewer and shared across every tab, which is
 * the whole point: outlook, lineup, waivers, trades, roster and schedule are
 * six routes rendering six views of *one* snapshot and *one* simulation.
 * Without this each of them paid the full cost again.
 */

const adapter = new SleeperAdapter();

/**
 * Iterations behind a page render.
 *
 * The whole cold-start cost of a league is here: the Sleeper round trips are
 * under 300ms and the artifact parse is cached, so the simulation is the wait.
 * Halving it from four thousand takes roughly a second and a half off the first
 * view of a league, which is the one a person actually notices.
 *
 * What it costs is resolution. A season simulated n times resolves probability
 * no finer than about 2/sqrt(n), so this moves the floor from 3.2 to 4.5
 * percentage points. That is a real loss, and it is why the header states the
 * count and the decision pages name their own resolution rather than printing a
 * precision they do not have. Anything a manager acts on — a trade in the
 * calculator, a waiver claim — is re-simulated at full count in the browser.
 */
const PAGE_ITERATIONS = 2_000;

/**
 * How long a loaded league stays fresh.
 *
 * Long enough that clicking through the tabs never re-simulates, short enough
 * that a waiver claim shows up while you still care. Live scoring is not served
 * from here — the numbers on these pages are projections, which do not move
 * minute to minute.
 */
const LEAGUE_TTL_MS = 5 * 60 * 1000;

export interface LeagueView {
  readonly snapshot: LeagueSnapshot;
  readonly context: SimContext;
  readonly result: SeasonSimResult;
  readonly teamNames: ReadonlyMap<string, string>;
  readonly myTeamId: string | null;
  readonly modelVersion: string | null;
  readonly generatedAt: string | null;
  readonly efficiencies: ReadonlyMap<string, import('@ffe/core').EfficiencyResult>;
  /** Wall-clock cost of building this view, for the footer's honesty line. */
  readonly loadMs: number;
}

export const listLeagues = ttlCache(
  LEAGUE_TTL_MS,
  (username: string, season: number) => `${username.toLowerCase()}:${season}`,
  async (username: string, season: number) => adapter.listLeagues(username, season),
);

/** Resolve a Sleeper handle, or null when no such user exists. */
export const resolveUser = async (username: string): Promise<string | null> => {
  try {
    return await adapter.resolveUserId(username);
  } catch {
    return null;
  }
};

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



const buildLeague = async (platformLeagueId: string, username: string): Promise<LeagueView> => {
  const startedAt = Date.now();
  const snapshot = await adapter.loadSnapshot(platformLeagueId);

  const weeks: number[] = [];
  for (let week = snapshot.asOfWeek; week <= snapshot.league.regularSeasonWeeks; week += 1) {
    weeks.push(week);
  }

  const [artifact, availability] = await Promise.all([
    loadArtifact(snapshot.league.season, snapshot.asOfWeek),
    loadAvailability(),
  ]);

  // Every league scores its own way — 42, 64 and 132 keys across Tyler's three.
  const rules = snapshot.league.scoring.raw;
  const pool = artifact === null ? new Map() : buildPool(artifact, weeks, rules, availability);

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

  const teamNames = new Map(snapshot.managers.map((m) => [m.id, m.teamName]));

  // Match on the platform account id, not the display name. Display names differ
  // between leagues and change mid-season; matching on them silently fails to
  // find your own team, which reads as "you are not in this league".
  //
  // Resolved before simulating rather than after, because knowing whose team is
  // whose lets this week's games be priced inside the same run.
  const myUserId = await resolveUser(username);
  const me =
    myUserId === null
      ? undefined
      : (snapshot.managers.find((m) => m.platformUserId === myUserId) ??
        snapshot.managers.find((m) => m.coOwnerUserIds.includes(myUserId)));
  const mine =
    me ?? snapshot.managers.find((m) => m.displayName.toLowerCase() === username.toLowerCase());

  const result = simulateSeason({
    snapshot,
    projections: projectSeason(teams, pool, weeks),
    iterations: PAGE_ITERATIONS,
    seed: context.seed ?? 0,
    // Free: pricing this week's games rides along on the season we already
    // simulate, instead of costing two more simulations per game.
    ...(mine === undefined ? {} : { leverage: { teamId: mine.id, week: snapshot.asOfWeek } }),
  });

  return {
    snapshot,
    context,
    result,
    teamNames,
    myTeamId: mine?.id ?? null,
    modelVersion: artifact?.modelVersion ?? null,
    generatedAt: artifact?.generatedAt ?? null,
    efficiencies,
    loadMs: Date.now() - startedAt,
  };
};

/**
 * One league, loaded and simulated once for every tab that needs it.
 */
export const loadLeague = ttlCache(
  LEAGUE_TTL_MS,
  (platformLeagueId: string, username: string) => `${platformLeagueId}:${username.toLowerCase()}`,
  buildLeague,
  { name: 'league' },
);

export { currentOdds };
