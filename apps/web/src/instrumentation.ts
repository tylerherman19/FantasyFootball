/**
 * Keep the expensive work warm, so no reader ever pays for it.
 *
 * The season simulation and the trade search are genuinely expensive — a few
 * seconds each — and memoizing them made every page after the first fast while
 * leaving the first one slow. That is the wrong page to leave slow: it is the
 * one a person actually notices, and "the site is slow" is a judgement formed
 * on first contact, not on average.
 *
 * So the server computes them for the configured leagues at startup and again
 * on a cycle shorter than the cache lifetime. By the time anyone asks, the
 * answer is already sitting in memory.
 *
 * `register` must finish before the server accepts traffic, so the warm-up is
 * started and deliberately not awaited.
 */

/** Comfortably inside the memo lifetime, so it never lapses. */
const REFRESH_MS = 4 * 60_000;

export function register() {
  // Only the Node.js server runtime can read the artifacts from disk.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const ids = (process.env.SLEEPER_LEAGUE_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  if (ids.length === 0) return;

  const username = process.env.SLEEPER_USERNAME ?? 'tylerherman';

  const warm = async () => {
    // Imported lazily: at module scope this would run during the build, where
    // there is no network and no reason to simulate anything.
    const { loadLeague } = await import('./lib/league-data');
    const { loadTrades } = await import('./lib/trade-data');
    const { weekLeverage } = await import('./lib/analysis');
    const { positionalStrength } = await import('./lib/positional-strength');

    for (const id of ids) {
      try {
        const view = await loadLeague(id, username);

        /*
         * Only the default objective is warmed.
         *
         * Warming all three multiplied the background work by three and the
         * warm-up started colliding with real requests for the same CPU — the
         * first page load went from six seconds to fifteen. The other
         * objectives are a deliberate click away, which is a fair place to pay
         * once.
         */
        /*
         * The outlook page's own derived work, not just the league load.
         *
         * Leverage runs two full season simulations per remaining game, and the
         * heat map solves a lineup for every roster. Warming `loadLeague` alone
         * left both of those to be paid on the first request, which is why the
         * outlook page stayed slow while every other tab went instant.
         */
        positionalStrength(view);

        if (view.myTeamId !== null) {
          weekLeverage(view, view.myTeamId, view.snapshot.asOfWeek);

          await loadTrades(view, view.myTeamId, {
            objective: 'balanced',
            targetPlayerId: null,
            targetPosition: null,
          });
        }
      } catch {
        // A league that fails to warm is not fatal: the request path will try
        // again and surface the real error to the reader if it persists.
      }
    }
  };

  void warm();
  const timer = setInterval(() => void warm(), REFRESH_MS);
  // Never hold the process open on account of the warm-up.
  timer.unref?.();
}
