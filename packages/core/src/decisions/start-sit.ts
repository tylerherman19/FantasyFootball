import type { PlayerId } from '../domain/index.js';
import { oddsDelta, type SimContext } from './odds.js';

/**
 * Start/sit, priced in championship probability.
 *
 * Projected points answer "who scores more on average". That is not the same
 * question as "who should I start", because your season is not an average — it
 * is a sequence of games you need to win. A high-floor player is worth more when
 * you're favoured and need only to avoid disaster; a volatile one is worth more
 * when you're an underdog and need variance. The simulator already knows all of
 * that, so the recommendation comes from it rather than from a points column.
 *
 * The most useful output here is often the honest one: **most start/sit calls
 * do not matter.** Telling a manager that two options differ by 0.1% of a title
 * saves them an hour of agonizing.
 */

export interface StartSitOption {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly projectedPoints: number;
}

export interface StartSitVerdict {
  readonly recommended: StartSitOption;
  readonly alternative: StartSitOption;
  /** Championship probability gained by starting the recommended player. */
  readonly titleGain: number;
  readonly playoffGain: number;
  readonly pointsGain: number;
  /** True when the gap is too small to be worth deliberating over. */
  readonly negligible: boolean;
  readonly explanation: string;
}

/**
 * Below this, the difference is within simulation noise and beneath the
 * precision our projections can support. Saying "it doesn't matter" is the
 * correct answer, not a cop-out.
 */
const NEGLIGIBLE_TITLE_GAIN = 0.002;

/**
 * Compare two players for one lineup spot.
 *
 * Implemented by temporarily removing the other option, which forces the
 * lineup solver to seat the one being tested — reusing the same machinery that
 * runs everything else rather than introducing a parallel code path that could
 * disagree with it.
 */
export const compareStartSit = (
  context: SimContext,
  teamId: string,
  optionA: StartSitOption,
  optionB: StartSitOption,
): StartSitVerdict => {
  const withA = oddsDelta(context, [{ teamId, drop: [optionB.playerId] }], teamId);
  const withB = oddsDelta(context, [{ teamId, drop: [optionA.playerId] }], teamId);

  const titleGap = withA.after.titlePct - withB.after.titlePct;
  const playoffGap = withA.after.playoffPct - withB.after.playoffPct;

  const aWins = titleGap >= 0;
  const recommended = aWins ? optionA : optionB;
  const alternative = aWins ? optionB : optionA;
  const titleGain = Math.abs(titleGap);
  const pointsGain = recommended.projectedPoints - alternative.projectedPoints;

  const negligible = titleGain < NEGLIGIBLE_TITLE_GAIN;

  let explanation: string;
  if (negligible) {
    explanation = 'either choice is fine — the difference is inside the model\'s own margin';
  } else if (pointsGain < 0) {
    // The interesting case: the lower projection is the better start, because
    // its shape fits the situation.
    explanation =
      `${recommended.name} projects ${Math.abs(pointsGain).toFixed(1)} fewer points but improves ` +
      `your title odds — the distribution fits your situation better than the average does`;
  } else {
    explanation = `${recommended.name} by ${pointsGain.toFixed(1)} projected points`;
  }

  return {
    recommended,
    alternative,
    titleGain,
    playoffGain: Math.abs(playoffGap),
    pointsGain,
    negligible,
    explanation,
  };
};

/** Rank a full set of options for one spot, best first. */
export const rankForSlot = (
  context: SimContext,
  teamId: string,
  options: readonly StartSitOption[],
): StartSitVerdict[] => {
  if (options.length < 2) return [];

  const best = options.reduce((a, b) => (a.projectedPoints >= b.projectedPoints ? a : b));

  return options
    .filter((option) => option.playerId !== best.playerId)
    .map((option) => compareStartSit(context, teamId, best, option))
    .sort((a, b) => b.titleGain - a.titleGain);
};
