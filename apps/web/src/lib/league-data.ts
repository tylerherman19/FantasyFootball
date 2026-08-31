import { unstable_cache } from 'next/cache';
import { SleeperAdapter, SleeperClient } from '@ffe/adapters';
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
import { ttlCache, type TtlCache } from './cache';
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

/*
 * Sleeper responses persist beyond this process.
 *
 * A league snapshot is around thirty requests. The client already shares them
 * inside one server, which is the whole answer on a machine that stays up and
 * no answer at all on a platform that recycles the instance between visits —
 * there, every cold request paid the full round trip again, which is most of
 * the second a first-time reader waited.
 *
 * The revalidate window is the same five minutes the league memo already uses,
 * so this makes nothing staler than it already was; it only stops the same
 * fetch being paid for once per instance instead of once per five minutes.
 */
const adapter = new SleeperAdapter(
  new SleeperClient(8, { requestInit: { next: { revalidate: 300 } } as RequestInit }),
);

/** FNV-1a. Short, stable, and not a security boundary — it keys a cache. */
const hash = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

/**
 * Iterations behind a page render.
 *
 * The whole cold-start cost of a league is here: the Sleeper round trips are
 * under 300ms and the artifact parse is cached, so the simulation is the wait.
 * Ten thousand is the product's normal-analysis floor. It gives a probability
 * resolution of roughly two percentage points (2/sqrt(n)); lower-count coarse
 * screens are still allowed inside trade and waiver candidate searches, but a
 * number presented as the league outlook comes from the full run. The result is
 * cached across routes and server instances, so this cost is paid once for each
 * roster/model version rather than on every navigation.
 */
const PAGE_ITERATIONS = 10_000;

/**
 * How long a loaded league stays fresh.
 *
 * Long enough that clicking through the tabs never re-simulates, short enough
 * that a waiver claim shows up while you still care. Live scoring is not served
 * from here — the numbers on these pages are projections, which do not move
 * minute to minute.
 */
const LEAGUE_TTL_MS = 5 * 60 * 1000;

/**
 * Memoize something derived from a league view.
 *
 * The pages are six views of one league, and every one of them was rebuilding
 * the same intermediate results from scratch. Team profiles alone are a
 * thousand-sample quantile draw for every rostered player — a sixth of a second
 * — and the outlook page, the power page and the dynasty page each did it
 * independently, on every navigation, for a result that cannot differ between
 * them.
 *
 * Keyed on the view's signature rather than on the view, because a `LeagueView`
 * is a new object on every cache miss and would key nothing. Two identical
 * leagues loaded seconds apart share the derived work, and concurrent callers
 * share one computation instead of racing to do it twice.
 */
export const derived = <T, A extends readonly unknown[] = []>(
  name: string,
  compute: (view: LeagueView, ...args: A) => Promise<T>,
  keyOf: (...args: A) => string = () => '',
): TtlCache<[LeagueView, ...A], T> =>
  ttlCache<[LeagueView, ...A], T>(
    LEAGUE_TTL_MS,
    (view, ...args) => `${view.signature}:${keyOf(...args)}`,
    compute as (...args: [LeagueView, ...A]) => Promise<T>,
    { name, maxEntries: 32 },
  );


export interface LeagueView {
  readonly snapshot: LeagueSnapshot;
  readonly context: SimContext;
  readonly result: SeasonSimResult;
  readonly teamNames: ReadonlyMap<string, string>;
  readonly myTeamId: string | null;
  readonly modelVersion: string | null;
  readonly generatedAt: string | null;
  readonly efficiencies: ReadonlyMap<string, import('@ffe/core').EfficiencyResult>;
  /**
   * Everything that changes the answer, as one string.
   *
   * The cache key for every view derived from this one — team profiles, roster
   * analysis, the dynasty read. Those are pure functions of the snapshot, the
   * simulation and the artifact, so two calls with the same signature must
   * produce the same result, and the six routes that each want them should
   * compute them once between them rather than once apiece.
   */
  readonly signature: string;
  /** Milliseconds per stage of the cold build. Empty on a cache hit. */
  readonly stages?: Readonly<Record<string, number>>;
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
  // Stage timings, so "the page is slow" can be answered with a breakdown
  // rather than a guess. Surfaced on the view and printed once per cold build.
  const stages: Record<string, number> = {};
  const stage = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const at = Date.now();
    try {
      return await work();
    } finally {
      stages[name] = Date.now() - at;
    }
  };
  /*
   * Start the file reads immediately, in parallel with Sleeper.
   *
   * Measured cold, the build split almost evenly three ways — sleeper 204ms,
   * artifact+availability 213ms, simulation 213ms — and the first two were
   * running in series for no reason. Neither the injury feed nor the identity
   * crosswalk depends on anything the league snapshot returns; only the
   * projection artifact does, because its filename carries the season and week.
   *
   * So the two independent reads are kicked off before awaiting Sleeper and
   * collected after. No new caching, no staleness, just work that was already
   * independent no longer queueing behind a network call.
   */
  const availabilityPromise = stage('availability', () => loadAvailability());
  const identitiesPromise = stage('crosswalk', () => loadIdentities());
  /*
   * Resolving the viewer is a Sleeper round trip that depends on the username
   * and nothing else. It used to be awaited after the artifact and the pool
   * were built, which put a whole network latency in series behind work it has
   * no relationship to. Started here, it costs nothing: it resolves while the
   * league snapshot is still in flight.
   */
  const userPromise = stage('resolve-user', () => resolveUser(username));

  const snapshot = await stage('sleeper', () => adapter.loadSnapshot(platformLeagueId));

  const weeks: number[] = [];
  const playoffRounds = Math.ceil(Math.log2(Math.max(snapshot.league.playoffTeams, 1)));
  const finalWeek = Math.max(
    snapshot.league.regularSeasonWeeks,
    snapshot.league.playoffStartWeek + playoffRounds - 1,
  );
  for (let week = snapshot.asOfWeek; week <= finalWeek; week += 1) {
    weeks.push(week);
  }

  const [artifact, availability] = await Promise.all([
    stage('artifact', () => loadArtifact(snapshot.league.season, snapshot.asOfWeek)),
    availabilityPromise,
  ]);

  // Every league scores its own way — 42, 64 and 132 keys across Tyler's three.
  const rules = snapshot.league.scoring.raw;
  const pool = artifact === null ? new Map() : buildPool(artifact, weeks, rules, availability);

  // Measured from what each manager actually did, not assumed. Falls back to
  // this league's own average until a manager has enough played weeks.
  const identities = await identitiesPromise;
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
  const myUserId = await userPromise;
  const me =
    myUserId === null
      ? undefined
      : (snapshot.managers.find((m) => m.platformUserId === myUserId) ??
        snapshot.managers.find((m) => m.coOwnerUserIds.includes(myUserId)));
  const mine =
    me ?? snapshot.managers.find((m) => m.displayName.toLowerCase() === username.toLowerCase());

  /*
   * The simulation is cached beyond this process, not just inside it.
   *
   * In-memory memoization only helps a server that stays alive. On a serverless
   * platform every recycled instance starts empty and re-simulates, which is why
   * the first request to a cold instance took seconds while every one after it
   * took milliseconds — the same page, the same numbers, timed an order of
   * magnitude apart depending on luck.
   *
   * Next's data cache persists across instances and deployments, so a cold
   * function reads a prepared result instead of simulating two thousand seasons
   * to reproduce it. This works because the run is deterministic: the seed comes
   * from the league, so a cached result is the identical result.
   *
   * The key carries everything that changes the answer — the rosters, the week,
   * the model artifact and the iteration count — so a trade or a waiver claim
   * produces a different key rather than a stale hit.
   */
  const rosterSignature = snapshot.rosters
    .map((roster) => `${roster.teamId}:${[...roster.playerIds].sort().join('.')}`)
    .join('|');

  // Long, and never shown to anyone. Hashed so a derived cache key is a short
  // string rather than a few kilobytes of roster repeated per entry.
  const signature = [
    snapshot.league.id,
    snapshot.asOfWeek,
    artifact?.generatedAt ?? 'no-artifact',
    mine?.id ?? 'no-team',
    hash(rosterSignature),
  ].join(':');

  const simulate = unstable_cache(
    async () =>
      simulateSeason({
        snapshot,
        projections: projectSeason(teams, pool, weeks),
        iterations: PAGE_ITERATIONS,
        seed: context.seed ?? 0,
        // Free: pricing this week's games rides along on the season we already
        // simulate, instead of costing two more simulations per game.
        ...(mine === undefined ? {} : { leverage: { teamId: mine.id, week: snapshot.asOfWeek } }),
      }),
    [
      'season-sim',
      snapshot.league.id,
      String(snapshot.asOfWeek),
      String(PAGE_ITERATIONS),
      artifact?.generatedAt ?? 'no-artifact',
      mine?.id ?? 'no-team',
      rosterSignature,
    ],
    { revalidate: 900 },
  );

  const result = await stage('simulation', () => simulate());

  /*
   * One line per cold build, so a slow page is a breakdown rather than a guess.
   *
   * Only on a cold build: a cache hit never reaches here, so this cannot become
   * per-request noise in the log.
   */
  console.log(
    `[league ${snapshot.league.name}] ${Date.now() - startedAt}ms — ` +
      Object.entries(stages)
        .sort(([, a], [, b]) => b - a)
        .map(([name, ms]) => `${name} ${ms}ms`)
        .join(', '),
  );

  return {
    snapshot,
    context,
    result,
    teamNames,
    myTeamId: mine?.id ?? null,
    modelVersion: artifact?.modelVersion ?? null,
    generatedAt: artifact?.generatedAt ?? null,
    efficiencies,
    signature,
    loadMs: Date.now() - startedAt,
    stages,
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
