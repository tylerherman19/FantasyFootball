/**
 * Whether a player will actually play, and what it costs if he doesn't.
 *
 * A projection assumes the player suits up. That assumption is wrong for
 * hundreds of players every week — Sleeper reports an injury status for over
 * six hundred right now — and it fails in the worst possible direction: the
 * lineup solver happily starts someone who is on injured reserve, and the
 * simulation counts points he cannot score.
 *
 * Statuses are mapped to a probability of playing rather than a boolean,
 * because "questionable" genuinely means questionable. Multiplying the
 * projection by that probability is the honest treatment: an eighteen-point
 * player who is 60% to suit up is worth about eleven, which is exactly how a
 * manager should weigh him against a healthy alternative.
 */

export type InjuryStatus = string | null | undefined;

/**
 * Probability a player with each status appears.
 *
 * The season-ending designations are hard zeroes; the game-time ones come from
 * the long-run rates these labels actually correspond to, which are far less
 * dire than managers assume for "questionable" and far more dire for
 * "doubtful".
 */
const PLAY_PROBABILITY: Readonly<Record<string, number>> = {
  IR: 0,
  PUP: 0,
  Out: 0,
  Sus: 0,
  DNR: 0,
  COV: 0.35,
  Doubtful: 0.25,
  Questionable: 0.72,
  NA: 0.9,
};

export const playProbability = (status: InjuryStatus): number => {
  if (status === null || status === undefined || status === '') return 1;
  return PLAY_PROBABILITY[status] ?? 1;
};

/** True when the player cannot appear at all, so he should never be started. */
export const isRuledOut = (status: InjuryStatus): boolean => playProbability(status) === 0;

export interface AvailabilityAdjustment {
  readonly mean: number;
  readonly sd: number;
  readonly playProbability: number;
  readonly note: string | null;
}

/**
 * Apply availability to a projection.
 *
 * The mean scales with the chance of playing. The spread *grows*, because a
 * player who might not play at all has a genuinely wider range of outcomes than
 * one who certainly will — a point most tools miss by scaling the mean alone
 * and quietly making a risky start look safe.
 */
export const applyAvailability = (
  mean: number,
  sd: number,
  status: InjuryStatus,
  onBye: boolean,
): AvailabilityAdjustment => {
  if (onBye) {
    return { mean: 0, sd: 0, playProbability: 0, note: 'on bye' };
  }

  const probability = playProbability(status);

  if (probability === 0) {
    return { mean: 0, sd: 0, playProbability: 0, note: status ?? 'out' };
  }

  if (probability === 1) {
    return { mean, sd, playProbability: 1, note: null };
  }

  // Variance of a mixture: play (mean, sd) with probability p, else zero.
  // Var = p*(sd^2 + mean^2) - (p*mean)^2, which exceeds p*sd^2 — the extra is
  // the uncertainty about whether he plays at all.
  const adjustedMean = mean * probability;
  const variance = probability * (sd * sd + mean * mean) - adjustedMean * adjustedMean;

  return {
    mean: adjustedMean,
    sd: Math.sqrt(Math.max(variance, 0)),
    playProbability: probability,
    note: `${status} · ${Math.round(probability * 100)}% to play`,
  };
};
