import { SleeperClient } from '@ffe/adapters';

/**
 * Live injury status, cached briefly.
 *
 * Projections are rebuilt weekly; injuries change daily. A player ruled out on
 * Saturday must not be in Sunday's optimal lineup, so this is read live rather
 * than baked into the artifact — but the underlying file is three megabytes, so
 * it is fetched at most every fifteen minutes and shared across requests.
 */

export interface Availability {
  readonly injuryStatus: string | null;
  readonly team: string | null;
  /**
   * The game-time designation this player carried earlier this week, if it has
   * since been removed.
   *
   * The platform reports the *current* status and nothing else, so the moment a
   * player is declared active his Questionable tag disappears and, as far as a
   * stateless reader can tell, he was never hurt at all. That is not a
   * cosmetic loss. A receiver who spent the week Questionable and is activated
   * ninety minutes before kickoff produces about 77% of his healthy self —
   * measured over 2,359 such appearances — and forgetting the tag prices him at
   * 100% in the exact hour a manager is deciding whether to start him.
   *
   * So the removal is remembered rather than the status. Nothing here predicts
   * anything; it only stops the model from unlearning something it saw four
   * hours ago.
   */
  readonly clearedFrom: string | null;
}

const CACHE_MS = 15 * 60 * 1000;

/**
 * The designation memory, and why it is scoped to a week.
 *
 * An injury designation is a fact about one game. Carrying it forward would
 * quietly discount a player who was Questionable in week 3 for the rest of the
 * season, which is worse than the forgetting it fixes. So the memory is keyed
 * by week and the previous week's is dropped whole.
 *
 * The week comes from the calendar rather than from the league, deliberately.
 * This module is loaded before the league snapshot exists — that parallelism is
 * most of what makes a cold page fast — and an NFL week runs Tuesday to Monday,
 * which a date can answer on its own. Taking it as an argument would mean
 * either serialising the two or accepting a caller who does not know it yet and
 * resets the memory every render.
 *
 * On `globalThis` for the same reason the request memo is: Next evaluates this
 * module more than once per server process, and a memory that resets whenever a
 * second copy is loaded remembers nothing.
 */
const MEMORY = Symbol.for('ffe.availability.designations');

interface Memory {
  week: number;
  /** Strongest game-time designation seen this week, by player. */
  seen: Map<string, string>;
}

const memory = (): Memory => {
  const host = globalThis as { [MEMORY]?: Memory };
  host[MEMORY] ??= { week: -1, seen: new Map() };
  return host[MEMORY];
};

/**
 * Whole weeks since a Tuesday, in UTC.
 *
 * The boundary is Tuesday rather than Sunday because that is when the injury
 * report cycle restarts: Monday night's game belongs to the week behind it, and
 * a designation is still worth remembering while it is being played.
 */
const designationWeek = (now = Date.now()): number => {
  // 1970-01-06 was a Tuesday.
  const TUESDAY_EPOCH = 5 * 24 * 60 * 60 * 1000;
  return Math.floor((now - TUESDAY_EPOCH) / (7 * 24 * 60 * 60 * 1000));
};

/** Doubtful outranks Questionable: the worse designation is the informative one. */
const SEVERITY: Readonly<Record<string, number>> = { Questionable: 1, Doubtful: 2 };

let cache: { at: number; data: Record<string, Availability> } | null = null;
let inFlight: Promise<Record<string, Availability>> | null = null;

const remember = (
  raw: Record<string, { injuryStatus: string | null; team: string | null }>,
  week: number,
): Record<string, Availability> => {
  const store = memory();

  if (store.week !== week) {
    store.week = week;
    store.seen = new Map();
  }

  const out: Record<string, Availability> = {};

  for (const [playerId, entry] of Object.entries(raw)) {
    const status = entry.injuryStatus;

    if (status !== null && status in SEVERITY) {
      const previous = store.seen.get(playerId);
      if (previous === undefined || (SEVERITY[status] ?? 0) > (SEVERITY[previous] ?? 0)) {
        store.seen.set(playerId, status);
      }
    }

    // Only a *removed* designation is a clearance. While the tag is still
    // showing, the ordinary play-probability haircut is the right treatment and
    // applying both would discount him twice.
    const carried = store.seen.get(playerId);
    out[playerId] = {
      injuryStatus: status,
      team: entry.team,
      clearedFrom: status === null && carried !== undefined ? carried : null,
    };
  }

  return out;
};

export const loadAvailability = async (): Promise<Record<string, Availability>> => {
  if (cache !== null && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (inFlight !== null) return inFlight;

  inFlight = (async () => {
    try {
      const raw = await new SleeperClient().getAvailability();
      const data = remember(raw, designationWeek());
      cache = { at: Date.now(), data };
      return data;
    } catch {
      // Stale availability beats none: a page that renders last hour's injury
      // report is far more useful than one that fails.
      return cache?.data ?? {};
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
};

/** Exposed for tests: the memory is process state and has to be resettable. */
export const forgetDesignations = (): void => {
  const store = memory();
  store.week = -1;
  store.seen = new Map();
  cache = null;
};

export { designationWeek, remember as rememberDesignations };
