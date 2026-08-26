"""Check whether the model's stated uncertainty is honest.

    uv run --project model python model/backtest/run_calibration.py 2023 2024
"""

from __future__ import annotations

import sys
from functools import partial

import json
from pathlib import Path

from model.backtest.calibration import calibrate, calibrate_by_position, recalibrate_spread
from model.backtest.harness import default_lake
from model.backtest.run_ladder import SCORING, SLEEPER_RULES
from model.features.store import FeatureStore
from model.models import marcel, v1_usage

if __name__ == "__main__":
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2022
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2025
    if last <= first:
        raise SystemExit("spread calibration needs at least one training season and a later validation season")

    ladder = [
        ("v0-marcel", partial(marcel.build, scoring=SCORING)),
        ("v1-usage-raw", partial(v1_usage.build, rules=SLEEPER_RULES, spread_multipliers={})),
    ]

    with FeatureStore(default_lake()) as store:
        for name, model in ladder:
            report = calibrate(
                store, model, name,
                seasons=range(first, last),
                weeks=range(1, 18),
                scoring=SCORING,
            )
            print(report.describe())
            print(f"  suggested spread multiplier: {recalibrate_spread(report):.3f}\n")

        # Fit only on seasons strictly before the validation season. The old
        # path measured and evaluated the spread on the same player-weeks,
        # which made the calibration claim in-sample by construction.
        measured = calibrate_by_position(
            store,
            ladder[-1][1],
            seasons=range(first, last),
            weeks=range(1, 18),
            scoring=SCORING,
        )

        validation_model = partial(
            v1_usage.build,
            rules=SLEEPER_RULES,
            spread_multipliers=measured,
        )
        validation = calibrate(
            store,
            validation_model,
            f"v1-usage-calibrated-oos-{last}",
            seasons=range(last, last + 1),
            weeks=range(1, 18),
            scoring=SCORING,
        )
        print("held-out validation")
        print(validation.describe())

        out = Path("model/artifacts/spread-calibration.json")

        multipliers = {position: round(value, 4) for position, value in measured.items()}
        out.write_text(
            json.dumps(
                {
                    "trainingSeasons": [first, last - 1],
                    "validationSeason": last,
                    "validationCoverage": validation.coverage,
                    "validationPitDeviation": validation.pit_deviation,
                    "multipliers": multipliers,
                    "note": "fit on prior seasons; evaluated once on the held-out final season",
                },
                indent=2,
            )
        )
        print(f"per-position spread multipliers -> {out}")
        for position, value in sorted(multipliers.items()):
            print(f"  {position:4s} x{value:.3f}")
