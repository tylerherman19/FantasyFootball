import { resample, seededRng, standardNormal, type Rng } from './random.js';
import type { PlayerId } from '../domain/index.js';
import { scoreStatLine, type StatLine } from '../projections/scoring.js';

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
  /** When present, draw football stats first and score the realized line. */
  readonly scenario?: StatLineScenario;
  /** Pre-scored exact stat-line outcomes for the season simulator hot loop. */
  readonly outcomes?: readonly number[];
}

export interface StatLineScenario {
  readonly stats: StatLine;
  readonly rules: Readonly<Record<string, number>>;
  /** Probability of appearing at all, including injury and role uncertainty. */
  readonly playProbability: number;
  readonly teamPlays: number;
  readonly passRate: number;
  readonly redZoneRate: number;
  readonly environmentMultiplier?: number;
  readonly schemeVolumeMultiplier?: number;
  readonly schemeEfficiencyMultiplier?: number;
}

const poisson = (mean: number, rng: Rng): number => {
  if (mean <= 0) return 0;
  if (mean > 20) return Math.max(0, Math.round(mean + Math.sqrt(mean) * standardNormal(rng)));
  const limit = Math.exp(-mean);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= rng();
  } while (product > limit);
  return count - 1;
};

const binomial = (trials: number, probability: number, rng: Rng): number => {
  const p = Math.min(1, Math.max(0, probability));
  if (trials > 40) {
    const mean = trials * p;
    const sd = Math.sqrt(trials * p * (1 - p));
    return Math.min(trials, Math.max(0, Math.round(mean + sd * standardNormal(rng))));
  }
  let hits = 0;
  for (let i = 0; i < trials; i += 1) if (rng() < p) hits += 1;
  return hits;
};

const positiveRate = (mean: number, cv: number, shock: number): number =>
  Math.max(0, mean * Math.exp(cv * shock - 0.5 * cv * cv));

/** Draw a coherent football stat line, then apply the league's exact rules. */
const sampleStatLine = (
  scenario: StatLineScenario,
  gameShock: number,
  ownShock: number,
  rng: Rng,
): number => {
  if (rng() >= Math.min(1, Math.max(0, scenario.playProbability))) return 0;

  const means = scenario.stats;
  const environment = Math.max(0.7, Math.min(1.3, scenario.environmentMultiplier ?? 1));
  const volumeScheme = Math.max(0.8, Math.min(1.2, scenario.schemeVolumeMultiplier ?? 1));
  const efficiencyScheme = Math.max(0.8, Math.min(1.2, scenario.schemeEfficiencyMultiplier ?? 1));
  const pace = Math.max(0.8, Math.min(1.2, scenario.teamPlays / 64));
  const teamVolume = positiveRate(environment * volumeScheme * pace, 0.1, gameShock);
  const roleVolume = positiveRate(teamVolume, 0.2, ownShock);
  const passVolume = roleVolume * Math.max(0.75, Math.min(1.25, scenario.passRate / 0.58));
  const rushVolume = roleVolume * Math.max(0.75, Math.min(1.25, (1 - scenario.passRate) / 0.42));
  const efficiency = positiveRate(efficiencyScheme, 0.18, 0.45 * gameShock + 0.55 * ownShock);

  const attempts = Math.max(0, Math.round((means.attempts ?? 0) * passVolume));
  const carries = Math.max(0, Math.round((means.carries ?? 0) * rushVolume));
  const targets = Math.max(0, Math.round((means.targets ?? 0) * passVolume));
  const completions = binomial(attempts, (means.completions ?? 0) / Math.max(means.attempts ?? 0, 1), rng);
  const receptions = binomial(targets, (means.receptions ?? 0) / Math.max(means.targets ?? 0, 1), rng);

  const line: Record<string, number> = { ...means, attempts, carries, targets, completions, receptions };
  line.passing_yards = positiveRate(
    attempts * ((means.passing_yards ?? 0) / Math.max(means.attempts ?? 0, 1)),
    0.18,
    ownShock,
  ) * efficiency;
  line.rushing_yards = positiveRate(
    carries * ((means.rushing_yards ?? 0) / Math.max(means.carries ?? 0, 1)),
    0.24,
    ownShock,
  ) * efficiency;
  line.receiving_yards = positiveRate(
    receptions * ((means.receiving_yards ?? 0) / Math.max(means.receptions ?? 0, 1)),
    0.28,
    ownShock,
  ) * efficiency;

  for (const stat of [
    'passing_tds',
    'passing_interceptions',
    'rushing_tds',
    'receiving_tds',
    'rushing_fumbles_lost',
    'receiving_fumbles_lost',
  ]) {
    const redZoneLift = stat.endsWith('_tds') ? 0.75 + 1.25 * scenario.redZoneRate : 1;
    const volume = stat.startsWith('rushing_') ? rushVolume : passVolume;
    line[stat] = poisson((means[stat] ?? 0) * volume * redZoneLift, rng);
  }

  // Kicker, defense and IDP counting stats do not share the offensive identity
  // above. Draw their non-skill counts as Poisson events instead of leaving
  // fractional sacks, tackles or field goals in a realized game.
  const modelled = new Set([
    'attempts', 'carries', 'targets', 'completions', 'receptions',
    'passing_yards', 'rushing_yards', 'receiving_yards',
    'passing_tds', 'passing_interceptions', 'rushing_tds', 'receiving_tds',
    'rushing_fumbles_lost', 'receiving_fumbles_lost',
  ]);
  for (const [stat, mean] of Object.entries(means)) {
    if (modelled.has(stat) || stat.startsWith('_') || mean <= 0) continue;
    line[stat] = poisson(mean * teamVolume, rng);
  }
  if (means._points_allowed !== undefined) {
    line._points_allowed = Math.max(0, means._points_allowed + 7 * gameShock);
  }

  return Math.max(0, scoreStatLine(line, scenario.rules));
};

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

/** Real outcome quantiles from the same draw the season simulator uses. */
export const playerScoreSamples = (
  player: CorrelatedPlayer,
  iterations = 2_000,
  seed = 0x51ced,
): number[] => {
  const rng = seededRng(seed);
  const drawn = new Float64Array(1);
  const scores = new Array<number>(Math.max(1, iterations));
  for (let i = 0; i < scores.length; i += 1) {
    sampleWeekInto([player], rng, drawn);
    scores[i] = drawn[0]!;
  }
  return scores;
};

export const playerScoreQuantiles = (
  player: CorrelatedPlayer,
  probabilities: readonly number[] = [0.25, 0.5, 0.75],
  iterations = 2_000,
  seed = 0x51ced,
): number[] => {
  const scores = playerScoreSamples(player, iterations, seed);
  scores.sort((a, b) => a - b);
  return probabilities.map((probability) => {
    const p = Math.min(1, Math.max(0, probability));
    return scores[Math.min(scores.length - 1, Math.floor(p * (scores.length - 1)))]!;
  });
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

    if (player.outcomes !== undefined && player.outcomes.length > 0) {
      const base = resample(player.outcomes, rng);
      out[i] = Math.max(0, base + player.sd * Math.sqrt(loading) * shared);
    } else {
      out[i] =
        player.scenario === undefined
          ? Math.max(0, player.mean + player.sd * shock)
          : sampleStatLine(player.scenario, Math.sqrt(loading) * shared, own, rng);
    }
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
