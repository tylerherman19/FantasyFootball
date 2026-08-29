from __future__ import annotations

import polars as pl

from model.features.store import AsOf, FeatureStore
from model.models.v1_usage import project_with_explanations


def test_projection_preserves_text_team_column(tmp_path) -> None:
    """Team context is categorical and must never enter the numeric cast list."""
    player_stats = tmp_path / "lake" / "player_stats"
    player_stats.mkdir(parents=True)
    pl.DataFrame(
        {
            "season": [2025, 2025],
            "week": [1, 2],
            "player_id": ["player-1", "player-1"],
            "position": ["RB", "RB"],
            "team": ["TEN", "TEN"],
            "carries": [12.0, 16.0],
            "rushing_yards": [48.0, 80.0],
        }
    ).write_parquet(player_stats / "fixture.parquet")

    with FeatureStore(tmp_path / "lake") as store:
        projections, explanations = project_with_explanations(store, AsOf(2025, 3))

    assert "carries" in projections["player-1"]
    assert explanations["player-1"].scheme["team"] == "TEN"
