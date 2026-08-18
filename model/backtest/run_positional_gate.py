"""Gate the kicker, team-defense and IDP models.

Built with the same machinery as the skill model, but that is not evidence they
work. Each is compared against the honest naive baseline for its group — project
every player at the positional average — and ships only if it beats it out of
sample. A model that cannot beat "assume everyone is average" is not a model.

    uv run --project model python model/backtest/run_positional_gate.py 2024 2024
"""

from __future__ import annotations

import sys
from functools import partial

import polars as pl

from model.backtest.harness import Prediction, compare, default_lake, walk_forward
from model.features.store import AsOf, FeatureStore
from model.models import v1_positional

#: nflverse columns, for scoring actuals.
KICKER_SCORING = {"fg_made_0_19": 3.0, "fg_made_20_29": 3.0, "fg_made_30_39": 3.0,
                  "fg_made_40_49": 4.0, "fg_made_50_59": 5.0, "fg_made_60_": 5.0,
                  "pat_made": 1.0, "fg_missed": -1.0}

IDP_SCORING = {"def_tackles_solo": 1.0, "def_tackle_assists": 0.5, "def_sacks": 4.0,
               "def_interceptions": 6.0, "def_fumbles_forced": 4.0, "def_fumbles": 4.0,
               "def_pass_defended": 2.0, "def_tds": 6.0}

#: Sleeper-style keys for the model, which rebuilds a stat line.
KICKER_RULES = {"fgm_0_19": 3.0, "fgm_20_29": 3.0, "fgm_30_39": 3.0, "fgm_40_49": 4.0,
                "fgm_50p": 5.0, "xpm": 1.0, "fgmiss": -1.0}

IDP_RULES = {"idp_tkl_solo": 1.0, "idp_tkl_ast": 0.5, "idp_sack": 4.0, "idp_int": 6.0,
             "idp_ff": 4.0, "idp_fum_rec": 4.0, "idp_pass_def": 2.0, "idp_def_td": 6.0}

IDP_POSITIONS = ["DL", "LB", "DB", "DE", "DT", "NT", "CB", "S", "SAF", "OLB", "ILB", "MLB"]


def naive_baseline(positions: list[str], scoring: dict[str, float]):
    """Everyone at the positional average — the bar any model must clear."""

    def build(store: FeatureStore, as_of: AsOf) -> list[Prediction]:
        history = store.as_of("player_stats", as_of, seasons_back=3).pl()
        if history.height == 0:
            return []

        frame = history.filter(pl.col("position").is_in(positions))
        if frame.height == 0:
            return []

        total = pl.lit(0.0)
        for column, weight in scoring.items():
            if column in frame.columns:
                total = total + pl.col(column).cast(pl.Float64).fill_null(0.0) * weight

        scored = frame.with_columns(total.alias("points"))
        mean = float(scored["points"].mean() or 0.0)
        sd = float(scored["points"].std() or 4.0)

        return [
            Prediction(player_id=str(pid), mean=mean, sd=sd)
            for pid in scored["player_id"].unique().to_list()
        ]

    return build


if __name__ == "__main__":
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2024

    groups = [
        ("kickers", ["K"], KICKER_SCORING,
         partial(v1_positional.build_kickers, rules=KICKER_RULES)),
        ("IDP", IDP_POSITIONS, IDP_SCORING,
         partial(v1_positional.build_idp, rules=IDP_RULES)),
    ]

    with FeatureStore(default_lake()) as store:
        for name, positions, scoring, model in groups:
            results = [
                walk_forward(store, naive_baseline(positions, scoring), f"{name}-naive",
                             range(first, last + 1), range(1, 18), scoring, positions),
                walk_forward(store, model, f"{name}-v1",
                             range(first, last + 1), range(1, 18), scoring, positions),
            ]
            print(compare(results, baseline_name=f"{name}-naive"))
            print()
