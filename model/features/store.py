"""Point-in-time feature store.

The models here are known math. What kills projects like this is **lookahead
leakage** — training on facts that weren't knowable at kickoff, producing a
backtest that looks brilliant and a live model that doesn't work.

So every read goes through `as_of`, and every dataset is classified:

- **serve-time safe** — available before kickoff in the live season. Legal at
  both training and inference.
- **train-time only** — published after the fact. Legal for research (computing
  stabilization constants, deciding which signals matter) and illegal at
  inference. Requesting one without `allow_train_only=True` raises.

FTN charting is the concrete trap: route participation and targets-per-route-run
are the best usage signals available, and they don't exist until the season is
over. Using them at inference would build training/serving skew straight into
the model.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import duckdb

from model.ingest.nflverse import TRAIN_TIME_ONLY


class LeakageError(RuntimeError):
    """Raised when a query would use information that wasn't knowable yet."""


@dataclass(frozen=True)
class AsOf:
    """The moment a model is pretending to stand in.

    Weeks are inclusive of everything *completed* before the target week, so
    `AsOf(2025, 8)` means "predicting week 8, having seen weeks 1-7".
    """

    season: int
    week: int

    def __post_init__(self) -> None:
        if self.week < 1:
            raise ValueError(f"week must be >= 1, got {self.week}")

    @property
    def last_completed_week(self) -> int:
        return self.week - 1


class FeatureStore:
    """DuckDB over the Parquet lake, with as-of filtering enforced on read."""

    def __init__(self, lake_root: Path) -> None:
        self.root = lake_root
        self.con = duckdb.connect(":memory:")

    def _glob(self, dataset: str) -> str:
        path = self.root / dataset
        if not path.exists():
            raise FileNotFoundError(f"dataset not synced: {path}")
        return str(path / "*.parquet")

    def raw(self, dataset: str, *, allow_train_only: bool = False) -> duckdb.DuckDBPyRelation:
        """Whole dataset, no time filter. Only for research and lake inspection."""
        if dataset in TRAIN_TIME_ONLY and not allow_train_only:
            raise LeakageError(
                f"{dataset!r} is published after the season ends and is not available at "
                f"inference time. Pass allow_train_only=True if this is research code that "
                f"will never run in the serving path."
            )
        # nflverse schemas drift between seasons — columns appear, and types
        # widen (2021's `fg_blocked_list` holds '45;47' where 2020's held an
        # int). DuckDB infers from the first file alone unless told to reconcile
        # across all of them, which surfaces as a cast error mid-query.
        return self.con.read_parquet(self._glob(dataset), union_by_name=True)

    def as_of(
        self,
        dataset: str,
        as_of: AsOf,
        *,
        seasons_back: int = 3,
        allow_train_only: bool = False,
    ) -> duckdb.DuckDBPyRelation:
        """Rows knowable before `as_of.week` kicks off.

        Prior seasons are included whole; the target season is truncated to
        completed weeks. `seasons_back` bounds how much history a feature may
        look at, so a feature can't quietly depend on 2016 while claiming to be
        a three-year rolling average.
        """
        # Train-time-only data is published once a season ends — so *prior*
        # seasons are legitimately knowable today, and only the current season is
        # off limits. Blocking the dataset outright would throw away the single
        # best source of defensive scheme tendencies, which persist year to year.
        # So: allow completed seasons, hard-stop the in-flight one.
        is_train_only = dataset in TRAIN_TIME_ONLY
        relation = self.raw(dataset, allow_train_only=is_train_only or allow_train_only)
        columns = set(relation.columns)

        if is_train_only and not allow_train_only and "season" in columns:
            relation = relation.filter(f"season < {as_of.season}")

        if "season" not in columns:
            # Reference tables (players, combine, draft picks) carry no season.
            # They're biographical, not performance, so there is nothing to leak.
            return relation

        earliest = as_of.season - seasons_back

        if "week" not in columns:
            return relation.filter(f"season >= {earliest} AND season <= {as_of.season}")

        return relation.filter(
            f"season >= {earliest} AND ("
            f"season < {as_of.season} OR "
            f"(season = {as_of.season} AND week <= {as_of.last_completed_week})"
            f")"
        )

    def close(self) -> None:
        self.con.close()

    def __enter__(self) -> FeatureStore:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
