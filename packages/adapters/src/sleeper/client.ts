import { AdapterError } from '../platform-adapter.js';

const V1 = 'https://api.sleeper.app/v1';
/** Undocumented but stable host that serves projections, stats and schedule. */
const V2 = 'https://api.sleeper.com';

interface FetchOptions {
  readonly retries?: number;
  /** Treat 404 as "nothing there" rather than an error. Sleeper 404s empty weeks. */
  readonly allow404?: boolean;
  /**
   * How long this response stays usable, in milliseconds. 0 disables caching.
   *
   * Set per endpoint rather than globally, because the right answer differs by
   * two orders of magnitude: the player file changes daily and costs three
   * megabytes, while a live matchup changes every few minutes.
   */
  readonly cacheMs?: number;
}

/** Rough freshness budgets, by how fast each endpoint actually changes. */
const TTL = {
  /** Handles are effectively permanent; the id behind one never changes. */
  user: 24 * 60 * 60 * 1000,
  /** Settings, scoring and roster slots change a few times a season at most. */
  league: 10 * 60 * 1000,
  /** Rosters move on waivers and trades — minutes, not seconds. */
  roster: 60 * 1000,
  /** Live scoring. Short enough to feel live, long enough to stop a stampede. */
  matchup: 60 * 1000,
  /** Completed weeks never change again. */
  settled: 6 * 60 * 60 * 1000,
  /** The 3MB player file. Injuries move on a daily cycle. */
  players: 30 * 60 * 1000,
  state: 5 * 60 * 1000,
} as const;

interface CacheEntry {
  readonly at: number;
  readonly ttl: number;
  readonly value: unknown;
}

interface SleeperCacheRegistry {
  readonly responses: Map<string, CacheEntry>;
  readonly pending: Map<string, Promise<unknown>>;
  generation: number;
}

/**
 * Response cache, shared by every client instance in the process.
 *
 * A single page view of one league touches thirty-odd endpoints, and a user
 * clicking through six tabs used to repeat all of them six times. Sharing the
 * cache across instances is deliberate: the app constructs adapters freely, and
 * a cache that only helped within one instance would help almost never.
 */
const CACHE_REGISTRY = Symbol.for('ffe.sleeper.cache');

const cacheRegistry = (): SleeperCacheRegistry => {
  const host = globalThis as { [CACHE_REGISTRY]?: SleeperCacheRegistry };
  host[CACHE_REGISTRY] ??= {
    responses: new Map(),
    pending: new Map(),
    generation: 0,
  };
  return host[CACHE_REGISTRY];
};

/** Drop expired entries so a long-lived server doesn't accumulate dead weeks. */
const evictExpired = (now: number): void => {
  const { responses } = cacheRegistry();
  for (const [key, entry] of responses) {
    if (now - entry.at >= entry.ttl) responses.delete(key);
  }
};

/** Forget everything cached. Exposed for tests and for a manual refresh. */
export const clearSleeperCache = (): void => {
  const cache = cacheRegistry();
  cache.generation += 1;
  cache.responses.clear();
  cache.pending.clear();
};

/**
 * Thin Sleeper HTTP client.
 *
 * Sleeper is unauthenticated and rate-limited by courtesy rather than by key,
 * so we cap concurrency and back off rather than firing 140 requests at once
 * the way My Fantasy Analyzer does on every page load.
 *
 * Responses are cached by URL with a per-endpoint lifetime, and concurrent
 * callers asking for the same URL share one request rather than racing.
 */
export class SleeperClient {
  #inFlight = 0;
  readonly #maxConcurrent: number;
  readonly #cacheEnabled: boolean;

  readonly #queue: (() => void)[] = [];

  constructor(maxConcurrent = 8, { cache = true }: { cache?: boolean } = {}) {
    this.#maxConcurrent = maxConcurrent;
    this.#cacheEnabled = cache;
  }

  async #withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#inFlight >= this.#maxConcurrent) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#inFlight += 1;
    try {
      return await fn();
    } finally {
      this.#inFlight -= 1;
      this.#queue.shift()?.();
    }
  }

  async #get<T>(url: string, opts: FetchOptions = {}): Promise<T | null> {
    const ttl = this.#cacheEnabled ? (opts.cacheMs ?? 0) : 0;

    if (ttl > 0) {
      const cache = cacheRegistry();
      const { responses, pending } = cache;
      const now = Date.now();
      const hit = responses.get(url);
      if (hit !== undefined && now - hit.at < hit.ttl) return hit.value as T | null;

      // Six tabs opening at once must not become six copies of the same fetch.
      const inFlight = pending.get(url);
      if (inFlight !== undefined) return (await inFlight) as T | null;

      const generation = cache.generation;
      const request = this.#fetch<T>(url, opts)
        .then((value) => {
          // A force-refresh may happen while this request is in flight. Its
          // caller may still use the result, but it must not repopulate the
          // newly-cleared cache with pre-refresh state.
          if (cache.generation === generation) {
            responses.set(url, { at: Date.now(), ttl, value });
            if (responses.size > 512) evictExpired(Date.now());
          }
          return value;
        })
        .finally(() => {
          if (pending.get(url) === request) pending.delete(url);
        });

      pending.set(url, request);
      return request;
    }

    return this.#fetch<T>(url, opts);
  }

  async #fetch<T>(url: string, opts: FetchOptions): Promise<T | null> {
    const retries = opts.retries ?? 3;

    return this.#withSlot(async () => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const res = await fetch(url, { headers: { accept: 'application/json' } });

          if (res.status === 404 && opts.allow404 === true) return null;

          if (res.status === 429 || res.status >= 500) {
            // Exponential backoff with jitter — Sleeper 429s under burst.
            const waitMs = 2 ** attempt * 250 + Math.random() * 250;
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }

          if (!res.ok) {
            throw new AdapterError(`Sleeper returned ${res.status}`, { url, status: res.status });
          }

          return (await res.json()) as T;
        } catch (err) {
          lastError = err;
          // Retrying a valid 4xx response cannot make it succeed. Only network
          // failures, rate limits and server errors are transient.
          if (err instanceof AdapterError) break;
          if (attempt === retries) break;
          await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
        }
      }

      throw new AdapterError('Sleeper request failed after retries', { url, cause: lastError });
    });
  }

  async #require<T>(url: string, opts: FetchOptions = {}): Promise<T> {
    const value = await this.#get<T>(url, opts);
    if (value === null) throw new AdapterError('Sleeper returned no body', { url });
    return value;
  }

  getUser(handleOrId: string): Promise<SleeperUser> {
    return this.#require(`${V1}/user/${encodeURIComponent(handleOrId)}`, { cacheMs: TTL.user });
  }

  getUserLeagues(userId: string, season: number): Promise<SleeperLeague[]> {
    return this.#require(`${V1}/user/${userId}/leagues/nfl/${season}`, { cacheMs: TTL.league });
  }

  getLeague(leagueId: string): Promise<SleeperLeague> {
    return this.#require(`${V1}/league/${leagueId}`, { cacheMs: TTL.league });
  }

  getRosters(leagueId: string): Promise<SleeperRoster[]> {
    return this.#require(`${V1}/league/${leagueId}/rosters`, { cacheMs: TTL.roster });
  }

  getLeagueUsers(leagueId: string): Promise<SleeperLeagueUser[]> {
    return this.#require(`${V1}/league/${leagueId}/users`, { cacheMs: TTL.league });
  }

  /**
   * @param settled Weeks already in the books are cached far longer — a played
   * week's box score is final, and re-fetching fourteen of them on every page
   * load was most of what made the app slow.
   */
  async getMatchups(leagueId: string, week: number, settled = false): Promise<SleeperMatchup[]> {
    return (
      (await this.#get<SleeperMatchup[]>(`${V1}/league/${leagueId}/matchups/${week}`, {
        allow404: true,
        cacheMs: settled ? TTL.settled : TTL.matchup,
      })) ?? []
    );
  }

  async getTransactions(leagueId: string, week: number, settled = false): Promise<SleeperTransaction[]> {
    return (
      (await this.#get<SleeperTransaction[]>(`${V1}/league/${leagueId}/transactions/${week}`, {
        allow404: true,
        cacheMs: settled ? TTL.settled : TTL.matchup,
      })) ?? []
    );
  }

  async getTradedPicks(leagueId: string): Promise<SleeperTradedPick[]> {
    return (
      (await this.#get<SleeperTradedPick[]>(`${V1}/league/${leagueId}/traded_picks`, {
        allow404: true,
        cacheMs: TTL.roster,
      })) ?? []
    );
  }

  getNflState(): Promise<SleeperNflState> {
    return this.#require(`${V1}/state/nfl`, { cacheMs: TTL.state });
  }

  /** ~3MB, cached for half an hour. Never fetch this per page load. */
  getAllPlayers(): Promise<Record<string, SleeperPlayer>> {
    return this.#require(`${V1}/players/nfl`, { cacheMs: TTL.players });
  }

  /**
   * Injury status and bye week only, extracted from the full player file.
   *
   * The projection artifact is rebuilt weekly, but injuries change daily — a
   * player ruled out on Saturday must not be started on Sunday. This is the
   * one piece that has to be read live rather than baked into the artifact.
   */
  async getAvailability(): Promise<Record<string, { injuryStatus: string | null; team: string | null }>> {
    const players = await this.getAllPlayers();
    const out: Record<string, { injuryStatus: string | null; team: string | null }> = {};

    for (const [id, player] of Object.entries(players)) {
      if (player.injury_status == null && player.team == null) continue;
      out[id] = { injuryStatus: player.injury_status ?? null, team: player.team ?? null };
    }

    return out;
  }

  async getWeeklyProjections(season: number, week: number): Promise<SleeperProjection[]> {
    const url = `${V2}/projections/nfl/${season}/${week}?season_type=regular`;
    return (await this.#get<SleeperProjection[]>(url, { allow404: true, cacheMs: TTL.players })) ?? [];
  }
}

// --- Wire types. Only the fields we actually consume are declared. ---

export interface SleeperUser {
  readonly user_id: string;
  readonly username: string;
  readonly display_name: string;
}

export interface SleeperLeagueUser {
  readonly user_id: string;
  readonly display_name: string;
  readonly metadata?: { readonly team_name?: string };
}

export interface SleeperLeague {
  readonly league_id: string;
  readonly name: string;
  readonly season: string;
  /** `pre_draft` | `drafting` | `in_season` | `complete`. */
  readonly status?: string;
  readonly total_rosters: number;
  readonly roster_positions: readonly string[];
  readonly scoring_settings: Readonly<Record<string, number>>;
  readonly settings: Readonly<Record<string, number>> & {
    /** 0 = redraft, 1 = keeper, 2 = dynasty, 3 = guillotine. */
    readonly type?: number;
    readonly playoff_teams?: number;
    readonly playoff_week_start?: number;
    readonly league_average_match?: number;
    /** Guillotine only: last week a team gets chopped. */
    readonly last_chopped_leg?: number;
    /** Season FAAB allowance. Populated even when the league doesn't use it. */
    readonly waiver_budget?: number;
    /** 0/1 = rolling or reverse-standings priority, 2 = FAAB bidding. */
    readonly waiver_type?: number;
  };
}

export interface SleeperRoster {
  readonly roster_id: number;
  readonly owner_id: string | null;
  readonly co_owners: readonly string[] | null;
  readonly players: readonly string[] | null;
  readonly starters: readonly string[] | null;
  readonly taxi: readonly string[] | null;
  readonly reserve: readonly string[] | null;
  readonly settings: {
    readonly wins: number;
    readonly losses: number;
    readonly ties: number;
    readonly fpts: number;
    readonly fpts_decimal?: number;
    readonly fpts_against?: number;
    readonly fpts_against_decimal?: number;
  };
}

export interface SleeperMatchup {
  readonly roster_id: number;
  readonly matchup_id: number | null;
  readonly points: number | null;
  readonly players_points: Readonly<Record<string, number>> | null;
  readonly starters: readonly string[] | null;
}

export interface SleeperTransaction {
  readonly transaction_id: string;
  readonly type: string;
  readonly status: string;
  readonly leg: number;
  readonly created: number;
  readonly roster_ids: readonly number[];
  readonly adds: Readonly<Record<string, number>> | null;
  readonly drops: Readonly<Record<string, number>> | null;
  readonly draft_picks: readonly {
    readonly season: string;
    readonly round: number;
    readonly roster_id: number;
    readonly owner_id: number;
  }[];
  readonly settings: { readonly waiver_bid?: number } | null;
}

export interface SleeperTradedPick {
  readonly season: string;
  readonly round: number;
  readonly roster_id: number;
  readonly owner_id: number;
}

export interface SleeperNflState {
  readonly season: string;
  readonly week: number;
  readonly season_type: string;
}

export interface SleeperPlayer {
  readonly player_id: string;
  readonly full_name?: string;
  readonly position?: string;
  readonly team?: string | null;
  readonly age?: number;
  readonly injury_status?: string | null;
  readonly fantasy_positions?: readonly string[] | null;
}

export interface SleeperProjection {
  readonly player_id: string;
  readonly stats: Readonly<Record<string, number>>;
}
