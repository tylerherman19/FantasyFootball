/**
 * The scenario band used by both the simulator-facing projections and
 * decision code. The model stores a calibrated mean and standard deviation;
 * these are the corresponding non-negative 25th, 50th and 75th percentiles.
 *
 * The simulator uses the same truncated-at-zero Gaussian approximation. The
 * band is intentionally not a confidence interval: it is an outcome range for
 * one player-week, not uncertainty about the model parameter.
 */

export interface PredictionQuantiles {
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
}

const NORMAL_Q25 = 0.6744897501960817;

export const predictionQuantiles = (mean: number, sd: number): PredictionQuantiles => {
  const centre = Number.isFinite(mean) ? Math.max(0, mean) : 0;
  const spread = Number.isFinite(sd) ? Math.max(0, sd) : 0;

  return {
    p25: Math.max(0, centre - NORMAL_Q25 * spread),
    p50: centre,
    p75: centre + NORMAL_Q25 * spread,
  };
};
