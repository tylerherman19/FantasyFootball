/**
 * Keep the expensive work warm, so no reader pays for it.
 *
 * A league load is thirty Sleeper requests and a full season simulation. The
 * cache means everyone after the first visitor gets it instantly, which leaves
 * exactly the wrong person waiting: the first one. "The site is slow" is a
 * judgement formed on first contact, not on the average.
 *
 * So the configured leagues are computed at startup and refreshed inside the
 * cache lifetime. `register` must finish before the server accepts traffic, so
 * the warm-up is started and deliberately not awaited.
 *
 * On a serverless platform this runs per instance boot rather than once, and an
 * instance that is recycled between visits will still serve a cold first
 * request. It is a real improvement on a long-lived server and a partial one
 * elsewhere; the durable fix is precomputing to storage.
 */

/** Comfortably inside the five-minute league cache, so it never lapses. */
const REFRESH_MS = 4 * 60_000;

export function register() {
  // Only the Node.js server runtime can reach the filesystem and Sleeper.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const ids = (process.env.SLEEPER_LEAGUE_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  if (ids.length === 0) return;

  const username = process.env.SLEEPER_USERNAME ?? '';
  if (username === '') return;

  const warm = async () => {
    // Imported lazily: at module scope this would run during the build, where
    // there is no network and nothing worth simulating.
    const { loadLeague } = await import('./lib/league-data');

    for (const id of ids) {
      try {
        await loadLeague(id, username);
      } catch {
        // A league that fails to warm is not fatal — the request path will try
        // again and surface a real error to the reader if it persists.
      }
    }
  };

  void warm();
  const timer = setInterval(() => void warm(), REFRESH_MS);
  // Never hold the process open on account of the warm-up.
  timer.unref?.();
}
