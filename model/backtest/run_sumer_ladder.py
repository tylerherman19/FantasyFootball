"""Does SumerSports defensive EPA make a matchup adjustment that wins?

    uv run --project model python model/backtest/run_sumer_ladder.py 2023 2025

v2's matchup adjustment (opponent-adjusted points allowed) already lost this
ladder monotonically — a real signal applied more strongly helps more, and
theirs degraded. v2_sumer swaps the defense ranking to prior-season SumerSports
defensive EPA/Play splits. This is the same test the v2 docstring asks for:
"if a better matchup feature turns up, this is the harness for it."

User-directed (2026-09-09): evaluate SumerSports weighted as the PRIMARY
matchup signal and report the shape honestly, including if the higher weight
hurts. The sweep IS the answer: weight 0.35 -> 0.70 -> 1.00 should help more at
each step if the signal is real.

Coverage note: SumerSports tables start in 2022, so 2023 is the first season
with a leak-free prior. v1-usage runs as the baseline.
"""

from __future__ import annotations

import sys
from functools import partial

from model.backtest.harness import compare, default_lake, walk_forward
from model.backtest.run_ladder import SCORING, SLEEPER_RULES
from model.features.store import FeatureStore
from model.models import v1_usage, v2_sumer

if __name__ == "__main__":
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2023
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2025

    ladder = [
        ("v1-usage", partial(v1_usage.build, rules=SLEEPER_RULES)),
        ("sumer-w0.35", partial(v2_sumer.build, rules=SLEEPER_RULES, weight=0.35)),
        ("sumer-w0.70", partial(v2_sumer.build, rules=SLEEPER_RULES, weight=0.70)),
        ("sumer-w1.00", partial(v2_sumer.build, rules=SLEEPER_RULES, weight=1.00)),
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

    print(compare(results, baseline_name="v1-usage"))
