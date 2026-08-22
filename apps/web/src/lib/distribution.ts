/**
 * The full predictive distribution behind a projection (§49).
 *
 * The model has always produced one — a mean and a calibrated spread, which the
 * simulator draws from ten thousand times — and the product showed the mean.
 * That is the number least useful for a decision: two players projected 14.0
 * are not the same player if one ranges 9–19 and the other 2–31, and the whole
 * argument for start/sit priced in title odds is that the shape matters.
 *
 * **Gaussian, truncated at zero, and deliberately the same one the simulator
 * uses.** Not because fantasy scoring is normal — it is right-skewed and
 * bounded below — but because a page that quotes a different distribution from
 * the one behind the championship odds is quoting a number the rest of the
 * product will contradict. The spread is calibrated against real forecast error
 * (`model/backtest/run_calibration.py`), which is what makes the interval mean
 * what it says.
 *
 * The truncation is where the honesty lives. A back projected 4.0 with a spread
 * of 6 has a Gaussian 10th percentile below zero, which is not a thing that can
 * happen. Clamping at zero is right, and it is stated rather than hidden,
 * because it also means the quoted median sits slightly above the raw mean for
 * low-projection players.
 */

/** Standard normal CDF, Abramowitz & Stegun 26.2.17. Accurate to ~1e-7. */
const normalCdf = (z: number): number => {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;

  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);

  return 0.5 * (1 + sign * y);
};

/** Inverse standard normal, Acklam's rational approximation. */
const normalQuantile = (p: number): number => {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];

  const low = 0.02425;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }

  if (p > 1 - low) return -normalQuantile(1 - p);

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
};

export interface Percentile {
  readonly label: string;
  readonly p: number;
  readonly value: number;
}

export interface ThresholdOdds {
  readonly threshold: number;
  readonly probability: number;
}

export interface Distribution {
  readonly mean: number;
  readonly sd: number;
  readonly percentiles: readonly Percentile[];
  readonly thresholds: readonly ThresholdOdds[];
  /** True where the Gaussian would have gone below zero and was clamped. */
  readonly truncated: boolean;
}

const LADDER: readonly { label: string; p: number }[] = [
  { label: '10th', p: 0.1 },
  { label: '25th', p: 0.25 },
  { label: 'Median', p: 0.5 },
  { label: '75th', p: 0.75 },
  { label: '90th', p: 0.9 },
];

/**
 * Thresholds worth quoting, chosen from the projection itself.
 *
 * A fixed 20/25/30 ladder is meaningless for a projection of 6 — every answer
 * is "about zero" — and uninformative for a projection of 25, where every
 * answer is "yes". Anchoring to round numbers above the mean keeps each line
 * carrying information.
 */
const thresholdsFor = (mean: number): number[] => {
  /*
   * Five-point steps, starting just above the projection.
   *
   * The first version stepped by ten above a projection of ten, which put a
   * 20.2-point receiver's ladder at 30/40/50 — and 40 and 50 both came back 0%,
   * so two of three lines carried no information. A useful ladder brackets the
   * outcomes that actually happen: for that receiver it is 25/30/35, where the
   * answers are 22%, 6% and 1%.
   */
  const step = 5;
  const first = Math.ceil((mean + 2) / step) * step;
  return [first, first + step, first + step * 2];
};

export const distributionOf = (mean: number, sd: number): Distribution => {
  const spread = Math.max(0.1, sd);

  const percentiles = LADDER.map(({ label, p }) => ({
    label,
    p,
    // Clamped: a fantasy week cannot go below zero, and a Gaussian tail that
    // does is an artefact of the approximation rather than a claim.
    value: Math.max(0, mean + normalQuantile(p) * spread),
  }));

  const thresholds = thresholdsFor(mean).map((threshold) => ({
    threshold,
    probability: 1 - normalCdf((threshold - mean) / spread),
  }));

  return {
    mean,
    sd: spread,
    percentiles,
    thresholds,
    truncated: mean + normalQuantile(0.1) * spread < 0,
  };
};
