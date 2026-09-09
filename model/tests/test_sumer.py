"""SumerSports features: the leak guard is the feature.

A same-season SumerSports table is a season-to-date aggregate with no week
column, so reading it in a backtest would leak unplayed weeks. Every builder in
model/features/sumer.py therefore reads `as_of.season - 1` exactly. These tests
plant a poisoned current-season table in the lake and prove it is never read.
"""

from __future__ import annotations

from pathlib import Path

import polars as pl

from model.features.store import AsOf, FeatureStore
from model.features.sumer import team_epa_prior, tendency_prior

SENTINEL = 999.0  # value only the poisoned current-season rows carry


def _team_rows(season: int, epa: float) -> list[dict]:
    return [{
        "season": season, "team": "KC", "epa_play": epa, "total_epa": 10.0,
        "success_pct": 0.5, "epa_pass": epa, "epa_rush": epa,
        "pass_yards": 4000, "pass_td": 30, "rush_yards": 1800, "rush_td": 12,
        "adot": 8.0, "scramble_pct": 0.06, "int_pct": 0.02,
        "fetched_at": "2026-09-09T00:00:00+00:00", "site_last_updated": "09-02-2026",
    }]


def _tendency_rows(season: int, rate: float) -> list[dict]:
    return [{
        "season": season, "team": "KC", "grouping": "2X2", "plays": 1000,
        "grouping_plays": 500, "rate": rate, "total_epa": 5.0, "epa_rank": 10,
        "epa_pass": 0.1, "epa_rush": 0.0,
        "fetched_at": "2026-09-09T00:00:00+00:00", "site_last_updated": "09-02-2026",
    }]


def _lake(root: Path) -> Path:
    for dataset, rows in (
        ("sumer_team_offense", _team_rows),
        ("sumer_team_defense", _team_rows),
    ):
        (root / dataset).mkdir(parents=True, exist_ok=True)
        pl.DataFrame(rows(2024, 0.10)).write_parquet(root / dataset / "2024.parquet")
        pl.DataFrame(rows(2025, 0.20)).write_parquet(root / dataset / "2025.parquet")
        # The trap: current-season snapshots that must never reach a backtest.
        pl.DataFrame(rows(2026, SENTINEL)).write_parquet(root / dataset / "2026.parquet")
    dataset = "sumer_formation_offense"
    (root / dataset).mkdir(parents=True, exist_ok=True)
    pl.DataFrame(_tendency_rows(2025, 0.48)).write_parquet(root / dataset / "2025.parquet")
    pl.DataFrame(_tendency_rows(2026, 0.99)).write_parquet(root / dataset / "2026.parquet")
    return root


def test_prior_reads_exactly_last_season(tmp_path: Path) -> None:
    store = FeatureStore(_lake(tmp_path))
    frame = team_epa_prior(store, AsOf(2025, 1))
    assert frame.height == 1
    assert frame["source_season"].item() == 2024
    assert frame["off_epa_play"].item() == 0.10
    assert frame["net_epa_play"].item() == 0.0  # 0.10 off - 0.10 def


def test_current_season_snapshot_is_never_read(tmp_path: Path) -> None:
    store = FeatureStore(_lake(tmp_path))
    frame = team_epa_prior(store, AsOf(2026, 8))
    assert frame.height == 1
    assert frame["source_season"].item() == 2025
    assert frame["off_epa_play"].item() == 0.20
    assert abs(frame["off_epa_play"].item()) != SENTINEL


def test_tendency_prior_also_excludes_current_season(tmp_path: Path) -> None:
    store = FeatureStore(_lake(tmp_path))
    frame = tendency_prior(store, AsOf(2026, 3), side="offense", kind="formation")
    assert frame.height == 1
    assert frame["rate"].item() == 0.48  # 2025 table, not the 0.99 trap


def test_no_prior_coverage_returns_empty(tmp_path: Path) -> None:
    store = FeatureStore(_lake(tmp_path))
    assert team_epa_prior(store, AsOf(2022, 1)).is_empty()  # 2021 predates the feed
    assert team_epa_prior(store, AsOf(2023, 1)).is_empty()  # no 2022 table in lake


def test_missing_dataset_returns_empty(tmp_path: Path) -> None:
    store = FeatureStore(tmp_path)  # nothing synced at all
    assert team_epa_prior(store, AsOf(2026, 1)).is_empty()
