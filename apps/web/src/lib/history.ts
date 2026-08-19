import { loadIdentities } from './crosswalk';
import { readArtifactFile } from './projections';

/**
 * What a player has actually done.
 *
 * A projection is a claim about the future with no memory of the past. This is
 * the past: three seasons of real games, kept as a distribution rather than an
 * average, because the average is the part that lies. Two receivers at twelve a
 * game are different assets if one ranges eight to sixteen and the other
 * alternates three and twenty-five.
 *
 * Built by `model/export_player_history.py`. Keyed on nflverse ids, so every
 * lookup goes through the crosswalk from Sleeper's ids — which is the only
 * reason league rosters and league-independent history can be joined at all.
 */

export interface SeasonLine {
  readonly g: number;
  readonly ppg: number;
  readonly std: number;
  readonly tgt: number;
  readonly car: number;
  readonly yds: number;
  readonly td: number;
}

/**
 * How a player has fared against the two opposite defensive postures.
 *
 * Present only when he has faced at least three of each — below that the
 * comparison is an anecdote, and an anecdote with a number attached is worse
 * than no number.
 */
export interface SchemeSplit {
  readonly twoHighPpg: number;
  readonly twoHighGames: number;
  readonly singleHighPpg: number;
  readonly singleHighGames: number;
  /** Positive means he does better against a soft two-high shell. */
  readonly gap: number;
}

export interface PlayerHistory {
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly games: number;
  readonly ppg: number;
  readonly floor: number;
  readonly median: number;
  readonly ceiling: number;
  readonly best: number;
  readonly boomRate: number;
  readonly bustRate: number;
  /** Spread relative to level, so a 20-point and a 6-point player compare. */
  readonly volatility: number;
  readonly bySeason: Readonly<Record<string, SeasonLine>>;
  readonly latestSeason: number;
  readonly trend: number | null;
  readonly schemeSplit: SchemeSplit | null;
}

export interface HistoryArtifact {
  readonly modelVersion: string;
  readonly seasons: readonly number[];
  readonly newestSeason: number;
  readonly playerCount: number;
  readonly basis: string;
  readonly players: Readonly<Record<string, PlayerHistory>>;
}

let cache: HistoryArtifact | null | undefined;

const loadArtifact = async (): Promise<HistoryArtifact | null> => {
  if (cache !== undefined) return cache;

  const raw = await readArtifactFile('player-history.json');
  try {
    cache = raw === null ? null : (JSON.parse(raw) as HistoryArtifact);
  } catch {
    cache = null;
  }
  return cache;
};

export interface HistoryIndex {
  readonly meta: HistoryArtifact | null;
  /** Keyed by Sleeper id, which is what every roster in this app speaks. */
  readonly bySleeperId: ReadonlyMap<string, PlayerHistory>;
}

let indexed: HistoryIndex | null = null;

export const loadHistory = async (): Promise<HistoryIndex> => {
  if (indexed !== null) return indexed;

  const [artifact, identities] = await Promise.all([loadArtifact(), loadIdentities()]);
  const bySleeperId = new Map<string, PlayerHistory>();

  if (artifact !== null) {
    for (const [sleeperId, identity] of Object.entries(identities)) {
      if (identity.gsisId === null) continue;
      const history = artifact.players[identity.gsisId];
      if (history !== undefined) bySleeperId.set(sleeperId, history);
    }
  }

  indexed = { meta: artifact, bySleeperId };
  return indexed;
};

/**
 * How much a player's history should move your read on him, in words.
 *
 * The numbers are already on the page; what a reader needs is which of them is
 * the one to pay attention to. A high floor and a low ceiling is a different
 * roster problem from the reverse, and both are different from a short record.
 */
export const reliabilityLabel = (history: PlayerHistory): string => {
  if (history.games < 12) return 'Short record';
  if (history.volatility < 0.45) return 'Reliable';
  if (history.volatility > 0.75) return 'Boom or bust';
  if (history.bustRate > 0.35) return 'Frequent duds';
  return 'Normal spread';
};

/** Which way a player is heading, when there is enough of a record to say. */
export const trendLabel = (history: PlayerHistory): string | null => {
  if (history.trend === null) return null;
  if (history.trend >= 3) return 'Rising';
  if (history.trend <= -3) return 'Falling';
  return 'Flat';
};
