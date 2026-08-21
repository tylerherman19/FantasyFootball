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
  // Measured, not assumed. `model/export_availability.py` joins every injury
  // report since 2016 to who actually recorded a stat line:
  //
  //   Questionable   n=4,488   play rate 0.593
  //   Doubtful       n=  529   play rate 0.008
  //   Out            n=3,232   play rate 0.000
  //
  // Both game-time labels were badly mispriced. Questionable was set at 0.72
  // against a measured 0.59, and Doubtful at 0.25 against 0.008 — a Doubtful
  // player essentially never plays, and pricing him at one-in-four put a man
  // who was not going to appear into the lineup solver every week.
  Doubtful: 0.008,
  Questionable: 0.593,
  NA: 0.9,
};

/**
 * How much a player who *does* play produces, against his own healthy baseline.
 *
 * The half almost nobody prices. A Questionable receiver who suits up is playing
 * hurt: measured over 2,359 such appearances he produced 0.774 of his own mean
 * in the weeks he carried no designation. Treating "he played" as "he was fine"
 * overstates every hurt starter, and it does so in the direction that loses
 * leagues, because the manager starts him.
 *
 * Compared to himself rather than to healthy players, because comparing across
 * players would mostly measure that better players get listed less often.
 *
 * Only Questionable carries a number: of 3,232 players listed Out exactly one
 * recorded a stat line, and Doubtful had four, so any ratio from those is a
 * single afternoon masquerading as a finding. Regenerate with
 * `model/export_availability.py`.
 */
const PRODUCTION_WHEN_PLAYING: Readonly<Record<string, number>> = {
  Questionable: 0.774,
};

/** Production multiplier for a player who appears carrying this designation. */
export const productionWhenPlaying = (status: InjuryStatus): number => {
  if (status === null || status === undefined || status === '') return 1;
  return PRODUCTION_WHEN_PLAYING[status] ?? 1;
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
 * **When you are deciding matters, and this does not know.** The play
 * probability is a Wednesday number: it is the long-run rate at which players
 * carrying this designation appeared, and it is correct for a decision made
 * before the inactives list drops. By Sunday morning you often *know*, and at
 * that point the haircut is too harsh — a Questionable receiver who has been
 * declared active is worth his production discount and nothing more.
 *
 * The effect is not small. A 20-point Questionable player prices at 9.2 here
 * (0.593 x 0.774), against 15.5 if you already know he is playing. Until the
 * app takes a kickoff-relative timestamp, mid-week is the assumption, and it
 * errs toward not starting a hurt player — which is the safer direction to be
 * wrong in, but it is a direction.
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

  /*
   * Two separate haircuts, because they are two separate facts.
   *
   * `probability` is whether he plays at all. `discount` is how well he plays
   * given that he does — measured, and materially below one for Questionable.
   * Applying only the first treats a hurt starter as his healthy self whenever
   * he suits up, which is precisely the case a manager needs warned about.
   */
  const discount = productionWhenPlaying(status);
  const playingMean = mean * discount;
  const playingSd = sd * discount;

  // Variance of a mixture: play (playingMean, playingSd) with probability p,
  // else zero. Var = p*(sd^2 + mean^2) - (p*mean)^2, which exceeds p*sd^2 —
  // the extra is the uncertainty about whether he plays at all.
  const adjustedMean = playingMean * probability;
  const variance =
    probability * (playingSd * playingSd + playingMean * playingMean) - adjustedMean * adjustedMean;

  return {
    mean: adjustedMean,
    sd: Math.sqrt(Math.max(variance, 0)),
    playProbability: probability,
    note:
      discount === 1
        ? `${status} · ${Math.round(probability * 100)}% to play`
        : `${status} · ${Math.round(probability * 100)}% to play, ${Math.round(discount * 100)}% of himself if he does`,
  };
};
