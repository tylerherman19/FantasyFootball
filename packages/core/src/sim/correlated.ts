import { resample, standardNormal, type Rng } from './random.js';
import type { PlayerId } from '../domain/index.js';

/**
 * Correlated player scoring.
 *
 * Simulating each player independently — which is what My Fantasy Analyzer does
 * and what almost every public tool does — treats a quarterback throwing for 400
 * yards as unrelated to his receivers catching them. It isn't, and the error is
 * not small: independence understates how extreme a team's weekly total can be,
 * which makes strong teams look safer than they are and long shots deader.
 *
 * The fix is one shared factor per NFL game. Draw the game environment first —
 * was this a shootout or a slog — then draw each player around it. A blowout
 * suppresses passing volume on both sides; a track meet lifts everyone.
 *
 * Structure per player:
 *
 *   points = mean + sd * ( sqrt(rho) * gameFactor + sqrt(1 - rho) * idiosyncratic )
 *
 * `rho` is the share of a player's variance explained by the game environment.
 * It's a per-position input, estimated from the empirical joint distribution
 * rather than assumed — receivers load heavily on their game, kickers barely.
 */

export interface CorrelatedPlayer {
  readonly playerId: PlayerId;
  readonly mean: number;
  readonly sd: number;
  /** NFL game this player's week depends on. Players sharing it move together. */
  readonly gameId: string;
  /** Share of variance from the game environment, 0-1. */
  readonly gameLoading: number;
  /** Historical residuals for this player's archetype, if available. */
  readonly residuals?: readonly number[];
}

/**
 * Sample one week of points for many players, respecting shared game factors.
 *
 * Returns points keyed by player id. Callers sum them per fantasy roster.
 */
export const sampleWeek = (
  players: readonly CorrelatedPlayer[],
  rng: Rng,
): Map<PlayerId, number> => {
  const drawn = new Float64Array(players.length);
  sampleWeekInto(players, rng, drawn);

  const out = new Map<PlayerId, number>();
  for (let i = 0; i < players.length; i += 1) out.set(players[i]!.playerId, drawn[i]!);
  return out;
};

/**
 * The same draw, written into a caller-owned array by player index.
 *
 * The season simulator calls this millions of times, and at that rate building
 * a fresh keyed map per team-week costs more than the arithmetic it wraps.
 * Callers that already know where each player sits pass a buffer instead.
 */
export const sampleWeekInto = (
  players: readonly CorrelatedPlayer[],
  rng: Rng,
  out: Float64Array,
): void => {
  // One environment draw per NFL game, shared by everyone playing in it.
  const gameFactors = new Map<string, number>();
  for (const player of players) {
    if (!gameFactors.has(player.gameId)) {
      gameFactors.set(player.gameId, standardNormal(rng));
    }
  }

  for (let i = 0; i < players.length; i += 1) {
    const player = players[i]!;
    const shared = gameFactors.get(player.gameId) ?? 0;
    const loading = Math.min(1, Math.max(0, player.gameLoading));

    // Resampled residuals carry the real skew; fall back to normal when a
    // player has no comparable history (rookies, new roles).
    const own =
      player.residuals !== undefined && player.residuals.length > 0
        ? resample(player.residuals, rng)
        : standardNormal(rng);

    const shock = Math.sqrt(loading) * shared + Math.sqrt(1 - loading) * own;

    out[i] = Math.max(0, player.mean + player.sd * shock);
  }
};

/**
 * Default game loadings by position.
 *
 * Quarterbacks and their pass catchers live or die by the game script;
 * kickers depend on it much less, and defenses are driven by the *opponent's*
 * environment rather than their own. These are starting values, replaced by
 * measured loadings once the correlation study runs against play-by-play.
 */
export const DEFAULT_GAME_LOADING: Readonly<Record<string, number>> = {
  QB: 0.45,
  RB: 0.3,
  WR: 0.4,
  TE: 0.35,
  K: 0.2,
  DEF: 0.25,
  DL: 0.15,
  LB: 0.15,
  DB: 0.15,
};
