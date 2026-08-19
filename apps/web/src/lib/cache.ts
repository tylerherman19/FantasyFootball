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

export interface TtlCache<Args extends readonly unknown[], T> {
  (...args: Args): Promise<T>;
  /** Drop one key, or everything when no key is given. */
  readonly invalidate: (key?: string) => void;
}

export const ttlCache = <Args extends readonly unknown[], T>(
  ttlMs: number,
  keyOf: (...args: Args) => string,
  compute: (...args: Args) => Promise<T>,
  { maxEntries = 64 }: { maxEntries?: number } = {},
): TtlCache<Args, T> => {
  const entries = new Map<string, Entry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  const cached = async (...args: Args): Promise<T> => {
    const key = keyOf(...args);
    const now = Date.now();

    const hit = entries.get(key);
    if (hit !== undefined && now - hit.at < ttlMs) return hit.value;

    const running = inFlight.get(key);
    if (running !== undefined) return running;

    const promise = compute(...args)
      .then((value) => {
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
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  };

  cached.invalidate = (key?: string): void => {
    if (key === undefined) entries.clear();
    else entries.delete(key);
  };

  return cached as TtlCache<Args, T>;
};
