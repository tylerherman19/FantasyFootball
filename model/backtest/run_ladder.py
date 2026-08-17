"""Run the ladder and print the report.

    uv run --project model python model/backtest/run_ladder.py 2023 2024
"""

from __future__ import annotations

import sys
from functools import partial

from model.backtest.harness import compare, default_lake, walk_forward
from model.features.store import FeatureStore
from model.models import marcel

#: Full-PPR stat weights, keyed by nflverse player_stats columns.
SCORING: dict[str, float] = {
    "passing_yards": 0.04,
    "passing_tds": 4.0,
    "passing_interceptions": -1.0,
    "rushing_yards": 0.1,
    "rushing_tds": 6.0,
    "receptions": 1.0,
    "receiving_yards": 0.1,
    "receiving_tds": 6.0,
    "rushing_fumbles_lost": -2.0,
    "receiving_fumbles_lost": -2.0,
    "sack_fumbles_lost": -2.0,
}

if __name__ == "__main__":
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2023
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2024

    with FeatureStore(default_lake()) as store:
        results = [
            walk_forward(
                store,
                partial(marcel.build, scoring=SCORING),
                "v0-marcel",
                seasons=range(first, last + 1),
                weeks=range(1, 18),
                scoring=SCORING,
            )
        ]

    print(compare(results, baseline_name="v0-marcel"))
