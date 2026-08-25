/**
 * Decision-time evaluation of a player projection.
 *
 * A projection mean is an estimate, not a decision. The useful question is
 * how much of that estimate is above this roster's replacement level, how much
 * uncertainty surrounds it, and how much evidence supports it. This module
 * keeps those dimensions separate from market value: market value is a
 * counterparty/acceptance currency, never a fantasy-points input.
 */

export type EvaluationObjective = 'winNow' | 'balanced' | 'rebuild';

export interface PlayerEvaluationInput {
  /** Mean weekly fantasy points from the stat-line model. */
  readonly projectedPoints: number;
  /** Predictive standard deviation in the same points scale. */
  readonly sd?: number;
  /** Evidence confidence, from 0 to 1; rookies should be explicitly low. */
  readonly confidence?: number;
  /** Outcome scenarios from the same distribution as the simulator. */
  readonly quantiles?: {
    readonly p25: number;
    readonly p50: number;
    readonly p75: number;
  };
  /** The replacement this roster would use without the player. */
  readonly replacementPoints?: number;
  readonly objective?: EvaluationObjective;
}

export interface PlayerEvaluation {
  readonly objective: EvaluationObjective;
  readonly projectedPoints: number;
  readonly replacementPoints: number;
  readonly sd: number;
  readonly confidence: number;
  /** The scenario used for this objective before evidence shrinkage. */
  readonly scenarioPoints: number;
  /** Mean after a small objective-specific uncertainty penalty. */
  readonly riskAdjustedPoints: number;
  /** Risk-adjusted mean shrunk toward this roster's replacement level. */
  readonly evidenceAdjustedPoints: number;
  /** Points discounted because they are uncertain or weakly evidenced. */
  readonly uncertaintyPenalty: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

const finiteNonNegative = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;

/**
 * Evaluate a projection for a decision, not for display.
 *
 * The objective changes risk tolerance, not the underlying forecast. Evidence
 * confidence shrinks only the amount above replacement, so a low-confidence
 * player does not get treated as worthless and a high-confidence starter does
 * not get a free pass on variance.
 */
export const evaluatePlayer = (input: PlayerEvaluationInput): PlayerEvaluation => {
  const objective = input.objective ?? 'balanced';
  const projectedPoints = finiteNonNegative(input.projectedPoints, 0);
  const replacementPoints = clamp(
    finiteNonNegative(input.replacementPoints, 0),
    0,
    projectedPoints,
  );
  const sd = finiteNonNegative(input.sd, 0);
  const confidence = clamp(
    input.confidence !== undefined && Number.isFinite(input.confidence)
      ? input.confidence
      : 0.75,
    0,
    1,
  );

  const scenarioPoints =
    input.quantiles === undefined
      ? projectedPoints
      : objective === 'winNow'
        ? Math.max(0, input.quantiles.p25)
        : objective === 'rebuild'
          ? Math.max(0, input.quantiles.p75)
          : Math.max(0, input.quantiles.p50);

  // A contender should pay more attention to downside; a rebuild has more
  // runway for variance. These are deliberately small point penalties, not a
  // second projection model.
  const riskAversion = objective === 'winNow' ? 0.14 : objective === 'rebuild' ? 0.06 : 0.10;
  const riskAdjustedPoints = Math.max(
    replacementPoints,
    input.quantiles === undefined ? scenarioPoints - riskAversion * sd : scenarioPoints,
  );
  const evidenceAdjustedPoints =
    replacementPoints + confidence * (riskAdjustedPoints - replacementPoints);

  return {
    objective,
    projectedPoints,
    replacementPoints,
    sd,
    confidence,
    scenarioPoints,
    riskAdjustedPoints,
    evidenceAdjustedPoints,
    uncertaintyPenalty: Math.max(0, projectedPoints - evidenceAdjustedPoints),
  };
};
