import { AdapterError } from '../platform-adapter.js';

const V1 = 'https://api.sleeper.app/v1';
/** Undocumented but stable host that serves projections, stats and schedule. */
const V2 = 'https://api.sleeper.com';

interface FetchOptions {
  readonly retries?: number;
  /** Treat 404 as "nothing there" rather than an error. Sleeper 404s empty weeks. */
  readonly allow404?: boolean;
}

/**
 * Thin Sleeper HTTP client.
 *
 * Sleeper is unauthenticated and rate-limited by courtesy rather than by key,
 * so we cap concurrency and back off rather than firing 140 requests at once
 * the way My Fantasy Analyzer does on every page load.
 */
export class SleeperClient {
  #inFlight = 0;
  readonly #maxConcurrent: number;
  readonly #queue: (() => void)[] = [];

  constructor(maxConcurrent = 8) {
    this.#maxConcurrent = maxConcurrent;
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
          if (attempt === retries) break;
          await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
        }
      }

      throw new AdapterError('Sleeper request failed after retries', { url, cause: lastError });
    });
  }

  async #require<T>(url: string): Promise<T> {
    const value = await this.#get<T>(url);
    if (value === null) throw new AdapterError('Sleeper returned no body', { url });
    return value;
  }

  getUser(handleOrId: string): Promise<SleeperUser> {
    return this.#require(`${V1}/user/${encodeURIComponent(handleOrId)}`);
  }

  getUserLeagues(userId: string, season: number): Promise<SleeperLeague[]> {
    return this.#require(`${V1}/user/${userId}/leagues/nfl/${season}`);
  }

  getLeague(leagueId: string): Promise<SleeperLeague> {
    return this.#require(`${V1}/league/${leagueId}`);
  }

  getRosters(leagueId: string): Promise<SleeperRoster[]> {
    return this.#require(`${V1}/league/${leagueId}/rosters`);
  }

  getLeagueUsers(leagueId: string): Promise<SleeperLeagueUser[]> {
    return this.#require(`${V1}/league/${leagueId}/users`);
  }

  async getMatchups(leagueId: string, week: number): Promise<SleeperMatchup[]> {
    return (await this.#get<SleeperMatchup[]>(`${V1}/league/${leagueId}/matchups/${week}`, { allow404: true })) ?? [];
  }

  async getTransactions(leagueId: string, week: number): Promise<SleeperTransaction[]> {
    return (
      (await this.#get<SleeperTransaction[]>(`${V1}/league/${leagueId}/transactions/${week}`, { allow404: true })) ?? []
    );
  }

  async getTradedPicks(leagueId: string): Promise<SleeperTradedPick[]> {
    return (await this.#get<SleeperTradedPick[]>(`${V1}/league/${leagueId}/traded_picks`, { allow404: true })) ?? [];
  }

  getNflState(): Promise<SleeperNflState> {
    return this.#require(`${V1}/state/nfl`);
  }

  /** ~3MB. Callers must cache this; never fetch it per page load. */
  getAllPlayers(): Promise<Record<string, SleeperPlayer>> {
    return this.#require(`${V1}/players/nfl`);
  }

  async getWeeklyProjections(season: number, week: number): Promise<SleeperProjection[]> {
    const url = `${V2}/projections/nfl/${season}/${week}?season_type=regular`;
    return (await this.#get<SleeperProjection[]>(url, { allow404: true })) ?? [];
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
