"""Proper scoring rules.

A projection is not a number, it's a claim about a distribution. Scoring it with
MAE alone rewards models that hedge toward the mean and punishes models that
correctly say "this guy is volatile". So we score three ways:

- **MAE / RMSE** — point-estimate accuracy. Familiar, comparable to every public
  projection set, and the only thing most of them can be scored on.
- **CRPS** — continuous ranked probability score, the standard in weather
  forecasting. Scores the whole predicted distribution against the single
  observed outcome, and reduces to MAE when the forecast is a point mass. This
  is the number that tells us whether our uncertainty is honest.
- **Log score** — how surprised the model was. Brutal about overconfidence,
  which is exactly the failure mode we're guarding against.

Lower is better for all three.
"""

from __future__ import annotations

from math import erf, sqrt

import numpy as np

SQRT_2PI = float(np.sqrt(2.0 * np.pi))
SQRT_2 = sqrt(2.0)
SQRT_PI = sqrt(np.pi)

_erf = np.vectorize(erf, otypes=[float])


def normal_cdf(z: np.ndarray) -> np.ndarray:
    """Standard normal CDF. Vectorized around math.erf to avoid a scipy dep."""
    return 0.5 * (1.0 + _erf(z / SQRT_2))


def mae(predicted: np.ndarray, actual: np.ndarray) -> float:
    return float(np.mean(np.abs(predicted - actual)))


def rmse(predicted: np.ndarray, actual: np.ndarray) -> float:
    return float(np.sqrt(np.mean((predicted - actual) ** 2)))


def crps_gaussian(mean: np.ndarray, sd: np.ndarray, actual: np.ndarray) -> float:
    """CRPS for a Gaussian forecast, in closed form (Gneiting & Raftery)."""
    sd = np.maximum(sd, 1e-6)
    z = (actual - mean) / sd
    pdf = np.exp(-0.5 * z**2) / SQRT_2PI

    return float(np.mean(sd * (z * (2.0 * normal_cdf(z) - 1.0) + 2.0 * pdf - 1.0 / SQRT_PI)))


def log_score_gaussian(mean: np.ndarray, sd: np.ndarray, actual: np.ndarray) -> float:
    """Negative log likelihood of the observed points under the forecast."""
    sd = np.maximum(sd, 1e-6)
    z = (actual - mean) / sd
    return float(np.mean(0.5 * z**2 + np.log(sd) + np.log(SQRT_2PI)))


def skill_score(model: float, baseline: float) -> float:
    """Fraction of the baseline's error removed. 0 = no better, 1 = perfect.

    Negative means the model is worse than the baseline, which is the result
    that matters most — a ladder rung that scores negative does not ship.
    """
    if baseline == 0:
        return 0.0
    return (baseline - model) / baseline
