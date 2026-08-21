"""Run the ladder and print the report.

    uv run --project model python model/backtest/run_ladder.py 2023 2024
"""

from __future__ import annotations

import sys
from functools import partial

from model.backtest.harness import compare, default_lake, walk_forward
from model.features.store import FeatureStore
from model.models import marcel, v1_usage, v2_matchup, v3_allocation

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

#: Sleeper scoring keys for models that rebuild a stat line, as opposed to v0
#: which works directly in nflverse column names.
SLEEPER_RULES: dict[str, float] = {
    "pass_yd": 0.04,
    "pass_td": 4.0,
    "pass_int": -1.0,
    "rush_yd": 0.1,
    "rush_td": 6.0,
    "rec": 1.0,
    "rec_yd": 0.1,
    "rec_td": 6.0,
}


if __name__ == "__main__":
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2023
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2024

    ladder = [
        ("v0-marcel", partial(marcel.build, scoring=SCORING)),
        ("v1-usage", partial(v1_usage.build, rules=SLEEPER_RULES)),
        ("v2-w0.35", partial(v2_matchup.build, rules=SLEEPER_RULES, weight=0.35)),
        ("v2-w0.70", partial(v2_matchup.build, rules=SLEEPER_RULES, weight=0.70)),
        ("v2-w1.00", partial(v2_matchup.build, rules=SLEEPER_RULES, weight=1.00)),
        # v3 adjusts opportunity rather than points. Swept the same way, because
        # the shape of the sweep is the finding: a real signal applied more
        # strongly should help more.
        ("v3-w0.25", partial(v3_allocation.build, rules=SLEEPER_RULES, weight=0.25)),
        ("v3-w0.50", partial(v3_allocation.build, rules=SLEEPER_RULES, weight=0.50)),
        ("v3-w1.00", partial(v3_allocation.build, rules=SLEEPER_RULES, weight=1.00)),
    ]

    with FeatureStore(default_lake()) as store:
        results = [
            walk_forward(
                store,
                model,
                name,
                seasons=range(first, last + 1),
                weeks=range(1, 18),
                scoring=SCORING,
            )
            for name, model in ladder
        ]

    print(compare(results, baseline_name="v0-marcel"))
