/**
 * Process-scoped memoization for the serving path.
 *
 * Three of this app's costs are paid per request and shouldn't be: parsing a
 * one-megabyte projection artifact, parsing a 1.7-megabyte identity crosswalk,
 * and running a four-thousand iteration season simulation. None of them depend
 * on anything about the request except the league, and all three are
 * deterministic — the simulation is seeded from the league id.
 *
 * The three loaders that need the artifact each called `loadArtifact`
 * separately, so a single page view parsed the same megabyte three times.
 *
 * This is deliberately *not* Next's `use cache`: that requires `cacheComponents`,
 * which changes how every dynamic page must be structured. A module-scope map
 * gets the same win here because the inputs are files on disk and a seeded PRNG.
 */

interface Entry<T> {
  readonly at: number;
  readonly value: Promise<T>;
}

/**
 * Caches live on `globalThis`, not in module scope.
 *
 * Next bundles the instrumentation hook and the route handlers separately, so a
 * plain module-level `Map` is instantiated more than once in the same process —
 * the background warm-up filled one copy while requests read another, and the
 * warm-up appeared to do nothing at all. Anchoring on the global keeps a single
 * store no matter how many times the module is evaluated.
 */
const REGISTRY = Symbol.for('ffe.cache.registry');

type Registry = Map<string, Map<string, unknown>>;

const registry = (): Registry => {
  const host = globalThis as { [REGISTRY]?: Registry };
  host[REGISTRY] ??= new Map();
  return host[REGISTRY];
};

const storeFor = <V>(name: string): Map<string, V> => {
  const all = registry();
  let store = all.get(name);
  if (store === undefined) {
    store = new Map();
    all.set(name, store);
  }
  return store as Map<string, V>;
};

/**
 * Memoize an async function on a string key.
 *
 * In-flight promises are stored rather than resolved values, so concurrent
 * requests for the same league share one computation instead of starting a
 * simulation each. A rejected promise is evicted, so a transient Sleeper outage
 * doesn't get cached as a permanent failure.
 */
export const memoize = <A extends readonly unknown[], T>(
  fn: (...args: A) => Promise<T>,
  keyOf: (...args: A) => string,
  ttlMs: number,
  /** Stable name for the shared store. Defaults to the function's own name. */
  name?: string,
): ((...args: A) => Promise<T>) => {
  const entries = storeFor<Entry<T>>(name ?? fn.name);

  return (...args: A): Promise<T> => {
    const key = keyOf(...args);
    const hit = entries.get(key);
    if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value;

    const value = fn(...args).catch((error: unknown) => {
      entries.delete(key);
      throw error;
    });

    entries.set(key, { at: Date.now(), value });
    return value;
  };
};

/**
 * The same thing for a synchronous function.
 *
 * Some of the expensive work here isn't async — leverage runs two full season
 * simulations per remaining game, entirely in-process — so it needs a cache
 * that doesn't force it to pretend otherwise.
 */
export const memoizeSync = <A extends readonly unknown[], T>(
  fn: (...args: A) => T,
  keyOf: (...args: A) => string,
  ttlMs: number,
  name?: string,
): ((...args: A) => T) => {
  const entries = storeFor<{ at: number; value: T }>(name ?? fn.name);

  return (...args: A): T => {
    const key = keyOf(...args);
    const hit = entries.get(key);
    if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value;

    const value = fn(...args);
    entries.set(key, { at: Date.now(), value });
    return value;
  };
};

/** Artifacts are rebuilt weekly; a day of caching still reloads on deploy. */
export const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a computed league stays good for.
 *
 * Five minutes rather than one. A shorter window meant the background warm-up
 * had to re-simulate constantly to stay ahead of expiry, and that work competed
 * with real requests for the same CPU — the warm-up made the site slower, which
 * is the opposite of its job. Rosters do not change on a one-minute cadence,
 * and anything a manager does themselves is a page navigation away from being
 * re-read anyway.
 */
export const LEAGUE_TTL_MS = 5 * 60 * 1000;

/**
 * A stable key for a league's scoring rules.
 *
 * Pools are scored per league, and Tyler's three leagues use 42, 64 and 132
 * scoring keys — so the pool cache has to distinguish them without assuming
 * key order is stable across Sleeper responses.
 */
export const rulesKey = (rules: Readonly<Record<string, number>>): string =>
  Object.entries(rules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
