/**
 * Refresh accounting: what was tried, what worked, and how old the data is.
 *
 * The application previously had no answer to "is this current?" — not a wrong
 * answer, no answer. The one automated refresh was a GitHub Action that
 * committed artifacts back to the repository and had never once succeeded, and
 * nothing recorded that it hadn't. A pipeline whose failures are invisible is
 * indistinguishable from one that was never built.
 *
 * So every provider runs inside `withRefreshTracking`, which records the
 * attempt before the work starts and the outcome after it — including, and
 * especially, failures. A provider that throws still leaves a row behind.
 *
 * Deliberately fail-soft. Freshness bookkeeping must never be the reason a
 * refresh fails or a page 500s: if the store is unreachable the work still runs
 * and the numbers still render, with freshness reported as unknown. The
 * alternative — bookkeeping that can take down the thing it is describing — is
 * worse than no bookkeeping.
 */

export type RefreshTrigger = 'cron' | 'manual' | 'deploy';

export type SourceHealth = 'healthy' | 'stale' | 'failing' | 'never' | 'unknown';

/** Row counts a provider reports about its own run. */
export interface RefreshCounts {
  readonly processed?: number;
  readonly added?: number;
  readonly updated?: number;
  readonly removed?: number;
  /**
   * How current the underlying data is, as opposed to when we fetched it.
   *
   * A successful run against a provider that has published nothing since
   * Tuesday is fresh work over stale facts, and only this field can tell the
   * difference.
   */
  readonly dataTimestamp?: string;
}

export interface RefreshOutcome extends RefreshCounts {
  readonly source: string;
  readonly status: 'ok' | 'failed';
  readonly durationMs: number;
  readonly error?: string;
}

export interface SourceFreshness {
  readonly source: string;
  readonly label: string;
  readonly health: SourceHealth;
  readonly lastSuccessAt: string | null;
  readonly dataTimestamp: string | null;
  readonly ageMinutes: number | null;
  readonly recordCount: number | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

export interface RefreshStore {
  beginRun(source: string, trigger: RefreshTrigger): Promise<number | null>;
  finishRun(runId: number | null, outcome: RefreshOutcome): Promise<void>;
  readFreshness(): Promise<readonly SourceFreshness[]>;
}

/** Used when no store is configured, so callers need no null checks. */
export const nullRefreshStore: RefreshStore = {
  async beginRun() {
    return null;
  },
  async finishRun() {},
  async readFreshness() {
    return [];
  },
};

/**
 * Run one provider, recording the attempt whatever happens.
 *
 * Re-throws after recording. A caller refreshing several sources decides for
 * itself whether one failure should stop the rest; this function's only job is
 * to make sure the failure is written down.
 */
export const withRefreshTracking = async <T>(
  store: RefreshStore,
  source: string,
  trigger: RefreshTrigger,
  work: () => Promise<T & RefreshCounts>,
): Promise<T & RefreshCounts> => {
  const startedAt = Date.now();
  const runId = await store.beginRun(source, trigger).catch(() => null);

  try {
    const result = await work();
    await store
      .finishRun(runId, {
        source,
        status: 'ok',
        durationMs: Date.now() - startedAt,
        // Spread rather than assigned: under `exactOptionalPropertyTypes` an
        // explicit `undefined` is not the same as an absent key, and "the
        // provider did not report a count" should be absence.
        ...(result.processed === undefined ? {} : { processed: result.processed }),
        ...(result.added === undefined ? {} : { added: result.added }),
        ...(result.updated === undefined ? {} : { updated: result.updated }),
        ...(result.removed === undefined ? {} : { removed: result.removed }),
        ...(result.dataTimestamp === undefined ? {} : { dataTimestamp: result.dataTimestamp }),
      })
      .catch(() => {});
    return result;
  } catch (cause) {
    await store
      .finishRun(runId, {
        source,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        // Truncated: a provider dumping an HTML error page into the column
        // helps nobody and makes the status view unreadable.
        error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 500),
      })
      .catch(() => {});
    throw cause;
  }
};

/** Supabase-backed, over PostgREST, using the secret key. */
export class PostgrestRefreshStore implements RefreshStore {
  readonly #url: string;
  readonly #key: string;

  constructor(url: string, secretKey: string) {
    this.#url = url.replace(/\/$/, '');
    this.#key = secretKey;
  }

  async beginRun(source: string, trigger: RefreshTrigger): Promise<number | null> {
    const rows = await this.#request<{ id: number }[]>('refresh_runs', {
      method: 'POST',
      prefer: 'return=representation',
      body: [{ source, trigger, status: 'running' }],
    });

    await this.#patchSource(source, {
      last_attempt_at: new Date().toISOString(),
      last_status: 'running',
      updated_at: new Date().toISOString(),
    });

    return rows?.[0]?.id ?? null;
  }

  async finishRun(runId: number | null, outcome: RefreshOutcome): Promise<void> {
    const now = new Date().toISOString();

    if (runId !== null) {
      await this.#request(`refresh_runs?id=eq.${runId}`, {
        method: 'PATCH',
        body: {
          finished_at: now,
          duration_ms: outcome.durationMs,
          status: outcome.status,
          records_processed: outcome.processed ?? null,
          records_added: outcome.added ?? null,
          records_updated: outcome.updated ?? null,
          records_removed: outcome.removed ?? null,
          error: outcome.error ?? null,
        },
      });
    }

    if (outcome.status === 'ok') {
      await this.#patchSource(outcome.source, {
        last_success_at: now,
        data_timestamp: outcome.dataTimestamp ?? now,
        last_status: 'ok',
        last_error: null,
        last_record_count: outcome.processed ?? null,
        consecutive_failures: 0,
        updated_at: now,
      });
      return;
    }

    // Read-then-write rather than a SQL increment, because PostgREST has no
    // expression update. A lost increment under concurrent refreshes costs one
    // count on a failure streak, which is not worth an RPC to prevent.
    const current = await this.#request<{ consecutive_failures: number }[]>(
      `data_sources?source=eq.${encodeURIComponent(outcome.source)}&select=consecutive_failures`,
    );
    const failures = (current?.[0]?.consecutive_failures ?? 0) + 1;

    await this.#patchSource(outcome.source, {
      last_status: 'failed',
      last_error: outcome.error ?? 'unknown error',
      consecutive_failures: failures,
      updated_at: now,
    });
  }

  async readFreshness(): Promise<readonly SourceFreshness[]> {
    const rows = await this.#request<
      {
        source: string;
        label: string;
        health: SourceHealth;
        last_success_at: string | null;
        data_timestamp: string | null;
        age_minutes: number | null;
        last_record_count: number | null;
        consecutive_failures: number;
        last_error: string | null;
      }[]
    >('data_freshness?select=*');

    if (rows === null) return [];

    return rows.map((row) => ({
      source: row.source,
      label: row.label,
      health: row.health,
      lastSuccessAt: row.last_success_at,
      dataTimestamp: row.data_timestamp,
      ageMinutes: row.age_minutes === null ? null : Math.round(row.age_minutes),
      recordCount: row.last_record_count,
      consecutiveFailures: row.consecutive_failures,
      lastError: row.last_error,
    }));
  }

  async #patchSource(source: string, patch: Record<string, unknown>): Promise<void> {
    await this.#request(`data_sources?source=eq.${encodeURIComponent(source)}`, {
      method: 'PATCH',
      body: patch,
    });
  }

  /**
   * Returns null rather than throwing on any failure.
   *
   * Includes the case where the migration has not been applied yet: PostgREST
   * answers 404 for an unknown table, and a product should not stop working
   * because its freshness bookkeeping is one deploy behind.
   */
  async #request<T>(
    path: string,
    { method = 'GET', body, prefer }: { method?: string; body?: unknown; prefer?: string } = {},
  ): Promise<T | null> {
    try {
      const res = await fetch(`${this.#url}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: this.#key,
          authorization: `Bearer ${this.#key}`,
          'content-type': 'application/json',
          prefer: prefer ?? 'return=minimal',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store',
      });

      if (!res.ok) return null;
      if (res.status === 204) return null;

      const text = await res.text();
      return text === '' ? null : (JSON.parse(text) as T);
    } catch {
      return null;
    }
  }
}

/** Build a store from the environment, or the null store if unconfigured. */
export const refreshStoreFromEnv = (env: Record<string, string | undefined>): RefreshStore => {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  return url && key ? new PostgrestRefreshStore(url, key) : nullRefreshStore;
};
