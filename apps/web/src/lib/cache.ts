/**
 * A small time-to-live memo, shared across requests in one server process.
 *
 * Next caches *rendered routes*, which does nothing for us: six tabs of one
 * league are six routes, and each one was independently re-fetching the same
 * thirty Sleeper endpoints and re-running the same season simulation. What
 * actually needs caching is the work behind them, keyed by league rather than
 * by URL.
 *
 * Concurrent callers share one computation rather than starting their own —
 * without that, opening the app cold in two tabs does everything twice, which
 * is exactly the moment it can least afford to.
 *
 * A failed computation is never cached: an error should be retried on the next
 * request, not remembered for fifteen minutes.
 */

interface Entry<T> {
  readonly at: number;
  readonly value: T;
}

/**
 * The stores live on `globalThis`, not in module scope.
 *
 * Next bundles the instrumentation hook and the route handlers separately, so a
 * plain module-level `Map` is instantiated more than once inside one server
 * process. Each copy then caches independently: a background warm-up fills one
 * while requests read another and miss every time, which looks exactly like the
 * cache not working. Anchoring on a global symbol keeps one store per name no
 * matter how many times this module is evaluated.
 */
const REGISTRY = Symbol.for('ffe.cache.registry');

type Registry = Map<
  string,
  { entries: Map<string, unknown>; inFlight: Map<string, unknown>; generation: number }
>;

const registry = (): Registry => {
  const host = globalThis as { [REGISTRY]?: Registry };
  host[REGISTRY] ??= new Map();
  return host[REGISTRY];
};

const storesFor = <T>(name: string) => {
  const all = registry();
  let store = all.get(name);
  if (store === undefined) {
    store = { entries: new Map(), inFlight: new Map(), generation: 0 };
    all.set(name, store);
  }
  return store as {
    entries: Map<string, Entry<T>>;
    inFlight: Map<string, Promise<T>>;
    generation: number;
  };
};

/**
 * Drop every memo in this process.
 *
 * What a "refresh Sleeper" button actually does. League data is read live on
 * each render behind a TTL memo, so there is nothing to re-fetch here — the
 * next request repopulates from the API on its own. Reaching through the
 * registry rather than tracking caches individually means a new `ttlCache` is
 * covered the moment it is created, instead of the day someone remembers to add
 * it to a list.
 */
export const invalidateAll = (): void => {
  for (const store of registry().values()) {
    store.generation += 1;
    store.entries.clear();
    // Existing callers retain their Promise, but new callers must start a
    // post-refresh request. Generation guards prevent old work from caching.
    store.inFlight.clear();
  }
};

export interface TtlCache<Args extends readonly unknown[], T> {
  (...args: Args): Promise<T>;
  /** Drop one key, or everything when no key is given. */
  readonly invalidate: (key?: string) => void;
}

export const ttlCache = <Args extends readonly unknown[], T>(
  ttlMs: number,
  keyOf: (...args: Args) => string,
  compute: (...args: Args) => Promise<T>,
  { maxEntries = 64, name }: { maxEntries?: number; name?: string } = {},
): TtlCache<Args, T> => {
  // Named so the store survives this module being evaluated more than once.
  const store = storesFor<T>(name ?? compute.name);
  const { entries, inFlight } = store;

  const cached = async (...args: Args): Promise<T> => {
    const key = keyOf(...args);
    const now = Date.now();

    const hit = entries.get(key);
    if (hit !== undefined && now - hit.at < ttlMs) return hit.value;

    const running = inFlight.get(key);
    if (running !== undefined) return running;

    const generation = store.generation;
    const promise = compute(...args)
      .then((value) => {
        // Do not let work started before a force-refresh repopulate cache.
        if (store.generation !== generation) return value;

        entries.set(key, { at: Date.now(), value });

        // Bounded so a long-lived process serving many leagues cannot grow
        // without limit. Oldest insertion goes first.
        if (entries.size > maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }

        return value;
      })
      .finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  };

  cached.invalidate = (key?: string): void => {
    store.generation += 1;
    if (key === undefined) {
      entries.clear();
      inFlight.clear();
    } else {
      entries.delete(key);
      inFlight.delete(key);
    }
  };

  return cached as TtlCache<Args, T>;
};
