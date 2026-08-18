"""Calibration: is the stated uncertainty honest?

Accuracy and calibration are different claims, and only one of them is usually
checked. A model can have excellent MAE and still be badly calibrated — if it
says "18.4 give or take 6" and the truth lands outside that range half the time,
every downstream probability built on it is wrong, including the playoff odds
users actually read.

Two tests, both standard in weather forecasting, which is the field that takes
this most seriously:

1. **PIT / probability integral transform.** Evaluate each forecast's CDF at the
   outcome that actually happened. If the forecasts are calibrated, those values
   are uniform on [0, 1]. Bowed toward the middle means the model is
   under-confident (intervals too wide); piled at the ends means over-confident
   (too narrow) — the dangerous direction.

2. **Interval coverage.** Of everything the model placed inside its 50%, 80% and
   90% intervals, how much actually landed there? A calibrated 80% interval
   contains the truth 80% of the time.

Both operate on player-weeks, of which the lake holds tens of thousands — far
more statistical power than the handful of league-seasons available for testing
playoff odds directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import erf, sqrt

import numpy as np
import polars as pl

from model.backtest.harness import Model, actual_points
from model.features.store import AsOf, FeatureStore

SQRT_2 = sqrt(2.0)


def _normal_cdf(z: np.ndarray) -> np.ndarray:
    return np.array([0.5 * (1.0 + erf(float(v) / SQRT_2)) for v in z])


@dataclass(frozen=True)
class CalibrationReport:
    model_name: str
    n: int
    #: Share of outcomes inside each nominal interval.
    coverage: dict[float, float]
    #: PIT histogram, ten equal bins. Uniform means calibrated.
    pit_bins: list[float]
    #: Mean absolute deviation of the PIT histogram from uniform.
    pit_deviation: float

    @property
    def verdict(self) -> str:
        eighty = self.coverage.get(0.80, 0.0)
        if eighty < 0.70:
            return "OVER-CONFIDENT — intervals too narrow, downstream odds will be too extreme"
        if eighty > 0.90:
            return "UNDER-CONFIDENT — intervals too wide, real signal is being blurred away"
        return "CALIBRATED — stated uncertainty matches observed frequency"

    def describe(self) -> str:
        lines = [
            f"{self.model_name}  n={self.n:,}",
            "  interval coverage (nominal -> actual)",
        ]
        for nominal, actual in sorted(self.coverage.items()):
            flag = "ok" if abs(actual - nominal) < 0.07 else "OFF"
            lines.append(f"    {nominal:.0%} -> {actual:.1%}   {flag}")

        histogram = "".join("#" * max(1, round(share * 100)) + "|" for share in self.pit_bins)
        lines.append(f"  PIT deviation from uniform: {self.pit_deviation:.3f}")
        lines.append(f"  PIT shape: {histogram}")
        lines.append(f"  {self.verdict}")
        return "\n".join(lines)


def calibrate(
    store: FeatureStore,
    model: Model,
    model_name: str,
    seasons: range,
    weeks: range,
    scoring: dict[str, float],
) -> CalibrationReport:
    """Walk forward, collecting every forecast and what actually happened."""
    pits: list[float] = []
    inside: dict[float, list[bool]] = {0.5: [], 0.8: [], 0.9: []}

    # z-scores for the two-sided intervals we report.
    half_widths = {0.5: 0.6745, 0.8: 1.2816, 0.9: 1.6449}

    for season in seasons:
        for week in weeks:
            predictions = model(store, AsOf(season, week))
            if not predictions:
                continue

            truth = actual_points(store, season, week, scoring)
            if truth.height == 0:
                continue

            predicted = pl.DataFrame(
                {
                    "player_id": [p.player_id for p in predictions],
                    "mean": [p.mean for p in predictions],
                    "sd": [max(p.sd, 1e-6) for p in predictions],
                }
            )
            joined = predicted.join(truth, on="player_id", how="inner")
            if joined.height == 0:
                continue

            mean = joined["mean"].to_numpy()
            sd = joined["sd"].to_numpy()
            actual = joined["actual"].to_numpy()

            z = (actual - mean) / sd
            pits.extend(_normal_cdf(z).tolist())

            for level, half_width in half_widths.items():
                inside[level].extend((np.abs(z) <= half_width).tolist())

    if not pits:
        return CalibrationReport(model_name, 0, {}, [0.0] * 10, 0.0)

    counts, _ = np.histogram(np.array(pits), bins=10, range=(0.0, 1.0))
    shares = (counts / counts.sum()).tolist()

    return CalibrationReport(
        model_name=model_name,
        n=len(pits),
        coverage={level: float(np.mean(values)) for level, values in inside.items() if values},
        pit_bins=shares,
        # Uniform would put 0.1 in every bin; this is how far off we are.
        pit_deviation=float(np.mean(np.abs(np.array(shares) - 0.1))),
    )


def calibrate_by_position(
    store: FeatureStore,
    model: Model,
    seasons: range,
    weeks: range,
    scoring: dict[str, float],
) -> dict[str, float]:
    """Spread multiplier per position, measured from forecast residuals.

    The right spread for a single player's week is the spread of *that
    forecast's* errors — not the spread of scores across all players at the
    position, which is far wider because it includes the difference between a
    star and a backup. Using the latter is why the model came out
    under-confident, and quarterbacks are affected differently from receivers,
    so the correction is measured per position rather than globally.
    """
    residuals: dict[str, list[float]] = {}
    stated: dict[str, list[float]] = {}

    for season in seasons:
        for week in weeks:
            predictions = model(store, AsOf(season, week))
            if not predictions:
                continue

            truth = actual_points(store, season, week, scoring)
            if truth.height == 0:
                continue

            positions = (
                store.raw("player_stats")
                .filter(f"season = {season} AND week = {week}")
                .pl()
                .select(pl.col("player_id").cast(pl.Utf8), pl.col("position").cast(pl.Utf8))
                .unique(subset=["player_id"])
            )

            predicted = pl.DataFrame(
                {
                    "player_id": [p.player_id for p in predictions],
                    "mean": [p.mean for p in predictions],
                    "sd": [max(p.sd, 1e-6) for p in predictions],
                }
            )
            joined = predicted.join(truth, on="player_id", how="inner").join(
                positions, on="player_id", how="inner"
            )

            for row in joined.iter_rows(named=True):
                position = str(row["position"])
                residuals.setdefault(position, []).append(float(row["actual"]) - float(row["mean"]))
                stated.setdefault(position, []).append(float(row["sd"]))

    out: dict[str, float] = {}
    for position, errors in residuals.items():
        if len(errors) < 100:
            continue
        actual_sd = float(np.std(np.array(errors)))
        assumed_sd = float(np.mean(np.array(stated[position])))
        if assumed_sd > 0:
            out[position] = round(actual_sd / assumed_sd, 4)

    return out


def recalibrate_spread(report: CalibrationReport) -> float:
    """Multiplier that would bring the 80% interval onto target.

    Rather than leaving a miscalibrated model in place, the spread can be scaled
    by a single factor — the simplest possible correction, and one that cannot
    change the ranking of players, only the confidence attached to them.
    """
    observed = report.coverage.get(0.80)
    if observed is None or observed <= 0:
        return 1.0

    # Under a normal, coverage c corresponds to a half-width of z(c). If we
    # observe less coverage than intended, the spread is too small by the ratio
    # of the required z-scores.
    from statistics import NormalDist

    normal = NormalDist()
    required = normal.inv_cdf(0.9)  # two-sided 80%
    observed_z = normal.inv_cdf(0.5 + observed / 2)

    if observed_z <= 0:
        return 1.0
    return float(required / observed_z)
