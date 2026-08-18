"""Walk-forward backtest harness — the ruler, built before the models.

For every (season, week) in the evaluation range: fit on everything knowable
before kickoff, predict that week, compare to what happened. Never peek.

An important limitation, stated plainly: **we cannot backtest against Sleeper's
historical projections.** Nobody publishes what they projected in week 6 of
2022 after the fact — that data only exists if someone stored it at the time,
which is exactly why the snapshot pipeline shipped first. So historical
backtests compare our ladder rungs against each other and against v0. The
head-to-head against Sleeper starts accumulating from this season's snapshots
and becomes meaningful after a dozen weeks.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import polars as pl

from model.backtest.scoring import crps_gaussian, log_score_gaussian, mae, rmse, skill_score
from model.features.store import AsOf, FeatureStore

#: Positions we project. K/DEF/IDP need their own stat mappings and models.
SKILL_POSITIONS = ("QB", "RB", "WR", "TE")


@dataclass(frozen=True)
class Prediction:
    """What a model claims about one player-week."""

    player_id: str
    mean: float
    sd: float


#: A model is any callable that, given the store and a point in time, returns
#: predictions for that week. Keeping it this loose means v0 through v4 — and
#: any external projection set we import — all score through the same path.
Model = Callable[[FeatureStore, AsOf], list[Prediction]]


@dataclass(frozen=True)
class WeekResult:
    season: int
    week: int
    n: int
    mae: float
    rmse: float
    crps: float
    log_score: float


@dataclass(frozen=True)
class BacktestResult:
    model_name: str
    weeks: list[WeekResult]

    @property
    def n(self) -> int:
        return sum(w.n for w in self.weeks)

    def _weighted(self, attr: str) -> float:
        if self.n == 0:
            return float("nan")
        return sum(getattr(w, attr) * w.n for w in self.weeks) / self.n

    @property
    def mae(self) -> float:
        return self._weighted("mae")

    @property
    def rmse(self) -> float:
        return self._weighted("rmse")

    @property
    def crps(self) -> float:
        return self._weighted("crps")

    @property
    def log_score(self) -> float:
        return self._weighted("log_score")

    def summary(self, baseline: BacktestResult | None = None) -> str:
        head = (
            f"{self.model_name:16s} n={self.n:>7,}  "
            f"MAE={self.mae:6.3f}  RMSE={self.rmse:6.3f}  "
            f"CRPS={self.crps:6.3f}  logscore={self.log_score:7.3f}"
        )
        if baseline is None or baseline.model_name == self.model_name:
            return head

        gain = skill_score(self.mae, baseline.mae)
        verdict = "SHIPS" if gain > 0 else "DOES NOT SHIP"
        return f"{head}\n{'':16s} vs {baseline.model_name}: MAE skill {gain:+.1%}  -> {verdict}"


def actual_points(
    store: FeatureStore,
    season: int,
    week: int,
    scoring: dict[str, float],
    positions: tuple[str, ...] | list[str] = SKILL_POSITIONS,
) -> pl.DataFrame:
    """What each player actually scored, under the given scoring rules.

    Computed from raw stat lines rather than a platform's points column, so the
    same history can be re-scored for any league without refetching.
    """
    stats = store.raw("player_stats").filter(f"season = {season} AND week = {week}").pl()
    if stats.height == 0:
        return pl.DataFrame({"player_id": [], "actual": []})

    total = pl.lit(0.0)
    for column, weight in scoring.items():
        if column in stats.columns:
            total = total + pl.col(column).cast(pl.Float64).fill_null(0.0) * weight

    return (
        stats.filter(pl.col("position").is_in(list(positions)))
        .select(pl.col("player_id").cast(pl.Utf8), total.alias("actual"))
        .group_by("player_id")
        .agg(pl.col("actual").sum())
    )


def walk_forward(
    store: FeatureStore,
    model: Model,
    model_name: str,
    seasons: range,
    weeks: range,
    scoring: dict[str, float],
    positions: tuple[str, ...] | list[str] = SKILL_POSITIONS,
) -> BacktestResult:
    """Score a model across many weeks, refitting at every step."""
    results: list[WeekResult] = []

    for season, week in _iter_weeks(seasons, weeks):
        predictions = model(store, AsOf(season, week))
        if not predictions:
            continue

        truth = actual_points(store, season, week, scoring, positions)
        if truth.height == 0:
            continue

        predicted = pl.DataFrame(
            {
                "player_id": [p.player_id for p in predictions],
                "mean": [p.mean for p in predictions],
                "sd": [p.sd for p in predictions],
            }
        )

        # Inner join: a player we didn't project can't be scored, and a player
        # who didn't play has no actual. Both are excluded rather than imputed,
        # since imputing zeros would flatter any model that projects nobody.
        joined = predicted.join(truth, on="player_id", how="inner")
        if joined.height == 0:
            continue

        mean = joined["mean"].to_numpy()
        sd = joined["sd"].to_numpy()
        actual = joined["actual"].to_numpy()

        results.append(
            WeekResult(
                season=season,
                week=week,
                n=joined.height,
                mae=mae(mean, actual),
                rmse=rmse(mean, actual),
                crps=crps_gaussian(mean, sd, actual),
                log_score=log_score_gaussian(mean, sd, actual),
            )
        )

    return BacktestResult(model_name=model_name, weeks=results)


def _iter_weeks(seasons: range, weeks: range) -> Iterator[tuple[int, int]]:
    for season in seasons:
        for week in weeks:
            yield season, week


def compare(results: list[BacktestResult], baseline_name: str) -> str:
    """Ladder report. A rung that doesn't beat the previous one doesn't ship."""
    baseline = next((r for r in results if r.model_name == baseline_name), None)
    lines = [f"{'':16s} {'':7s}  walk-forward, out of sample", ""]
    lines.extend(r.summary(baseline) for r in results)
    return "\n".join(lines)


def default_lake() -> Path:
    return Path(__file__).resolve().parents[2] / "data" / "lake"
