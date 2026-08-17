"""Leakage guarantees.

These are the most important tests in the repo. If they pass and the model is
bad, we learn something. If they fail, every backtest number is a lie.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from model.features.store import AsOf, FeatureStore, LeakageError
from model.ingest.nflverse import TRAIN_TIME_ONLY

LAKE = Path(__file__).resolve().parents[2] / "data" / "lake"

pytestmark = pytest.mark.skipif(not LAKE.exists(), reason="lake not synced")


@pytest.fixture
def store() -> FeatureStore:
    with FeatureStore(LAKE) as s:
        yield s


def test_as_of_excludes_the_target_week(store: FeatureStore) -> None:
    """Predicting week 8 must not see week 8 — that's the whole game."""
    rows = store.as_of("player_stats", AsOf(2024, 8)).filter("season = 2024").fetchall()
    weeks = {r[store.as_of("player_stats", AsOf(2024, 8)).columns.index("week")] for r in rows}
    assert weeks, "expected some 2024 rows before week 8"
    assert max(weeks) == 7


def test_week_one_sees_no_current_season_data(store: FeatureStore) -> None:
    """At week 1 no games have been played yet, so the current season
    contributes nothing — which is precisely why Week 1 projections lean
    entirely on priors, aging curves and draft capital."""
    relation = store.as_of("player_stats", AsOf(2023, 1))
    seasons = {r[relation.columns.index("season")] for r in relation.fetchall()}
    assert max(seasons) == 2022


def test_as_of_excludes_future_seasons(store: FeatureStore) -> None:
    relation = store.as_of("player_stats", AsOf(2023, 10))
    seasons = {r[relation.columns.index("season")] for r in relation.fetchall()}
    assert max(seasons) == 2023


def test_as_of_bounds_history(store: FeatureStore) -> None:
    """A 'three year rolling' feature must not quietly reach back to 2016."""
    relation = store.as_of("player_stats", AsOf(2024, 5), seasons_back=2)
    seasons = {r[relation.columns.index("season")] for r in relation.fetchall()}
    assert min(seasons) >= 2022


@pytest.mark.parametrize("dataset", sorted(TRAIN_TIME_ONLY))
def test_train_only_datasets_carry_a_season_column(store: FeatureStore, dataset: str) -> None:
    """Without a season column the as-of filter matches everything and silently
    leaks. The guard must not be able to no-op."""
    assert "season" in store.raw(dataset, allow_train_only=True).columns


@pytest.mark.parametrize("dataset", sorted(TRAIN_TIME_ONLY))
def test_train_only_data_is_limited_to_completed_seasons(store: FeatureStore, dataset: str) -> None:
    """Prior seasons are published and legal; the in-flight season is not."""
    relation = store.as_of(dataset, AsOf(2024, 8))
    seasons = {r[relation.columns.index("season")] for r in relation.fetchall()}
    assert seasons, f"expected some pre-2024 {dataset} rows"
    assert max(seasons) <= 2023


def test_unfiltered_reads_of_train_only_data_are_refused(store: FeatureStore) -> None:
    """`raw()` has no time filter at all, so for a post-season dataset it would
    hand back the in-flight season. Only `as_of()`, which truncates to completed
    seasons, is safe."""
    with pytest.raises(LeakageError, match="after the season ends"):
        store.raw("ftn_charting")


def test_train_time_only_is_available_when_explicitly_requested(store: FeatureStore) -> None:
    """Research code may use it — for stabilization constants, not inference."""
    relation = store.raw("ftn_charting", allow_train_only=True)
    assert relation.limit(1).fetchone() is not None


def test_reference_tables_have_no_time_filter(store: FeatureStore) -> None:
    """Combine results are biographical, not performance. Nothing to leak."""
    relation = store.as_of("combine", AsOf(2024, 8))
    assert relation.limit(1).fetchone() is not None


def test_week_zero_is_rejected() -> None:
    with pytest.raises(ValueError, match="week must be >= 1"):
        AsOf(2024, 0)
