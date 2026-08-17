"""v0 — the Marcel baseline.

Deliberately dumb, and famously hard to beat by much. Named for the baseball
system that embarrassed far more sophisticated projections for years:

1. weight recent games more than old ones
2. regress toward the positional mean, harder the less you've played
3. adjust for age

That's it. No matchups, no Vegas, no usage decomposition. Its entire job is to
be the number every later rung must beat out of sample. A v1 that can't clear
Marcel isn't a model, it's a hunch with extra steps.
"""

from __future__ import annotations

import numpy as np
import polars as pl

from model.backtest.harness import SKILL_POSITIONS, Prediction
from model.features.store import AsOf, FeatureStore

#: Games of prior history to weight. Beyond this, football roles have usually
#: changed enough that the data is noise.
LOOKBACK_GAMES = 24

#: Half-life in games. A game 8 weeks ago counts half as much as last week's.
HALF_LIFE_GAMES = 8.0

#: Regression strength, in "games of league-average performance" added to every
#: player's record. Chosen per position because a QB's output stabilizes faster
#: than a running back's. Empirically tuned in v1; here they are round numbers
#: on purpose, so v0 stays a baseline rather than a fitted model.
REGRESSION_GAMES: dict[str, float] = {"QB": 4.0, "RB": 6.0, "WR": 6.0, "TE": 5.0}

#: Peak age by position, and the penalty per year away from it. Crude, and
#: roughly right: backs fall off a cliff, receivers age gracefully.
PEAK_AGE: dict[str, float] = {"QB": 28.0, "RB": 25.0, "WR": 27.0, "TE": 27.0}
AGE_DECAY_PER_YEAR: dict[str, float] = {"QB": 0.010, "RB": 0.035, "WR": 0.015, "TE": 0.015}


def _weights(n: int) -> np.ndarray:
    """Exponential recency weights, most recent game last."""
    ages = np.arange(n - 1, -1, -1, dtype=float)
    return 0.5 ** (ages / HALF_LIFE_GAMES)


def _age_multiplier(position: str, age: float | None) -> float:
    if age is None or not np.isfinite(age):
        return 1.0
    peak = PEAK_AGE.get(position, 27.0)
    decay = AGE_DECAY_PER_YEAR.get(position, 0.02)
    # Only penalize decline. Improvement toward peak is left to the data,
    # because young players with real production shouldn't be marked down.
    return float(1.0 - decay * max(0.0, age - peak))


def build(store: FeatureStore, as_of: AsOf, scoring: dict[str, float]) -> list[Prediction]:
    """Project every skill-position player for `as_of.week`."""
    history = store.as_of("player_stats", as_of, seasons_back=3).pl()
    if history.height == 0:
        return []

    total = pl.lit(0.0)
    for column, weight in scoring.items():
        if column in history.columns:
            total = total + pl.col(column).cast(pl.Float64).fill_null(0.0) * weight

    frame = (
        history.filter(pl.col("position").is_in(SKILL_POSITIONS))
        .select(
            pl.col("player_id").cast(pl.Utf8),
            pl.col("position").cast(pl.Utf8),
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            total.alias("points"),
        )
        .sort(["player_id", "season", "week"])
    )

    league_mean = (
        frame.group_by("position").agg(pl.col("points").mean().alias("pos_mean")).to_dicts()
    )
    pos_mean = {row["position"]: row["pos_mean"] for row in league_mean}

    # Residual spread per position, used as the forecast's sd. Crude for v0 —
    # v1 splits within-player from between-player variance properly.
    pos_sd = {
        row["position"]: row["pos_sd"]
        for row in frame.group_by("position").agg(pl.col("points").std().alias("pos_sd")).to_dicts()
    }

    ages = _player_ages(store, as_of)

    predictions: list[Prediction] = []

    for (player_id,), group in frame.group_by(["player_id"], maintain_order=True):
        recent = group.tail(LOOKBACK_GAMES)
        points = recent["points"].to_numpy()
        if points.size == 0:
            continue

        position = str(recent["position"][-1])
        baseline = pos_mean.get(position, 0.0)

        weights = _weights(points.size)
        weighted_games = float(weights.sum())
        weighted_points = float((points * weights).sum())

        # Regression to the mean: add REGRESSION_GAMES worth of league-average
        # performance to what the player actually did. A 20-game veteran barely
        # moves; a two-game rookie is pulled most of the way back.
        padding = REGRESSION_GAMES.get(position, 6.0)
        mean = (weighted_points + baseline * padding) / (weighted_games + padding)
        mean *= _age_multiplier(position, ages.get(str(player_id)))

        predictions.append(
            Prediction(
                player_id=str(player_id),
                mean=max(0.0, mean),
                sd=float(pos_sd.get(position) or 7.0),
            )
        )

    return predictions


def _player_ages(store: FeatureStore, as_of: AsOf) -> dict[str, float]:
    """Age at the time being predicted, from weekly rosters."""
    try:
        rosters = store.as_of("weekly_rosters", as_of, seasons_back=1).pl()
    except FileNotFoundError:
        return {}

    if rosters.height == 0 or "age" not in rosters.columns:
        return {}

    latest = (
        rosters.select(
            pl.col("gsis_id").cast(pl.Utf8).alias("player_id"),
            pl.col("age").cast(pl.Float64),
            pl.col("season"),
            pl.col("week"),
        )
        .drop_nulls("player_id")
        .sort(["player_id", "season", "week"])
        .group_by("player_id")
        .agg(pl.col("age").last())
    )

    return dict(zip(latest["player_id"].to_list(), latest["age"].to_list(), strict=True))
