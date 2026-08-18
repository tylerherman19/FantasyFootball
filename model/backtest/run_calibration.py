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
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2024

    ladder = [
        ("v0-marcel", partial(marcel.build, scoring=SCORING)),
        ("v1-usage", partial(v1_usage.build, rules=SLEEPER_RULES)),
    ]

    with FeatureStore(default_lake()) as store:
        for name, model in ladder:
            report = calibrate(
                store, model, name,
                seasons=range(first, last + 1),
                weeks=range(1, 18),
                scoring=SCORING,
            )
            print(report.describe())
            print(f"  suggested spread multiplier: {recalibrate_spread(report):.3f}\n")

        # Export per-position multipliers for the shipping model. Measured, not
        # tuned by hand, and re-derivable whenever the model changes.
        measured = calibrate_by_position(
            store,
            ladder[-1][1],
            seasons=range(first, last + 1),
            weeks=range(1, 18),
            scoring=SCORING,
        )

        out = Path("model/artifacts/spread-calibration.json")

        # Compose with whatever correction is already applied, rather than
        # replacing it. The model loads this file, so a measurement taken with
        # the correction live reads ~1.0 by construction — writing that verbatim
        # would silently undo the calibration on the next run.
        existing: dict[str, float] = {}
        if out.exists():
            existing = json.loads(out.read_text()).get("multipliers", {})

        multipliers = {
            position: round(existing.get(position, 1.0) * value, 4)
            for position, value in measured.items()
        }
        out.write_text(
            json.dumps(
                {"seasons": [first, last], "multipliers": multipliers, "note": "composed with prior calibration"},
                indent=2,
            )
        )
        print(f"per-position spread multipliers -> {out}")
        for position, value in sorted(multipliers.items()):
            print(f"  {position:4s} x{value:.3f}")
