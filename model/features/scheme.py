"""Defensive scheme profiles, and the offensive context they act on.

Most tools apply matchup adjustments player-by-player, which double-counts and
breaks arithmetic — eleven receivers cannot each gain 8% of the targets. The
approach here follows the plan: characterize the defense, apply it to the
quarterback first because he is the valve, then propagate to pass catchers as a
change in *allocation* rather than a change in the total.

This module builds step one: what each defense actually does.

Availability, which matters as much as the math: coverage shells, box counts and
pressure come from participation charting, published only after a season ends.
So a defense's scheme profile is a *prior-season* feature during the year —
legal, because last season is public, and sound, because scheme tendencies are
among the stickiest things in football (a two-high coordinator stays a two-high
coordinator). In-season drift is picked up separately from play-by-play signals
that are available live, like sack rate and air yards allowed.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import polars as pl

from model.features.store import AsOf, FeatureStore

#: Coverage shells with two deep safeties. These compress deep passing, push
#: targets underneath, and — by taking a defender out of the box — quietly make
#: life easier for running backs.
TWO_HIGH_SHELLS = ("COVER_2", "COVER_4", "COVER_6", "2_MAN")

#: Five or more rushers is a blitz by the usual convention.
BLITZ_THRESHOLD = 5

#: Six or fewer defenders in the box is a light box.
LIGHT_BOX_MAX = 6


@dataclass(frozen=True)
class SchemeProfile:
    """One defense's tendencies over one season. Rates are 0-1."""

    team: str
    season: int
    plays: int
    blitz_rate: float
    pressure_rate: float
    man_rate: float
    two_high_rate: float
    light_box_rate: float
    mean_time_to_throw: float


def _defense_from_game_id(frame: pl.DataFrame) -> pl.DataFrame:
    """Participation names the offense; the defense is the other team.

    Game ids look like `2024_07_KC_SF` (away then home), so the defense is
    whichever of the two isn't in possession.
    """
    parts = pl.col("nflverse_game_id").str.split("_")
    away = parts.list.get(2)
    home = parts.list.get(3)

    return frame.with_columns(
        pl.when(pl.col("possession_team") == home).then(away).otherwise(home).alias("defense")
    )


def defensive_profiles(store: FeatureStore, as_of: AsOf, seasons_back: int = 2) -> list[SchemeProfile]:
    """Scheme profile per defense, from completed seasons only."""
    raw = store.as_of("pbp_participation", as_of, seasons_back=seasons_back).pl()
    if raw.height == 0:
        return []

    frame = _defense_from_game_id(raw)

    passes = frame.filter(pl.col("defense_man_zone_type").is_not_null())
    if passes.height == 0:
        return []

    aggregated = (
        passes.group_by(["defense", "season"])
        .agg(
            pl.len().alias("plays"),
            (pl.col("number_of_pass_rushers") >= BLITZ_THRESHOLD).mean().alias("blitz_rate"),
            pl.col("was_pressure").cast(pl.Float64).mean().alias("pressure_rate"),
            (pl.col("defense_man_zone_type") == "MAN_COVERAGE").mean().alias("man_rate"),
            pl.col("defense_coverage_type").is_in(TWO_HIGH_SHELLS).mean().alias("two_high_rate"),
            (pl.col("defenders_in_box") <= LIGHT_BOX_MAX).mean().alias("light_box_rate"),
            pl.col("time_to_throw").cast(pl.Float64).mean().alias("mean_time_to_throw"),
        )
        .drop_nulls("defense")
        .sort(["season", "blitz_rate"], descending=[True, True])
    )

    return [
        SchemeProfile(
            team=row["defense"],
            season=int(row["season"]),
            plays=int(row["plays"]),
            blitz_rate=float(row["blitz_rate"] or 0.0),
            pressure_rate=float(row["pressure_rate"] or 0.0),
            man_rate=float(row["man_rate"] or 0.0),
            two_high_rate=float(row["two_high_rate"] or 0.0),
            light_box_rate=float(row["light_box_rate"] or 0.0),
            mean_time_to_throw=float(row["mean_time_to_throw"] or 0.0),
        )
        for row in aggregated.to_dicts()
    ]


def opponent_adjust(
    observations: pl.DataFrame,
    *,
    unit_col: str,
    opponent_col: str,
    value_col: str,
    ridge: float = 4.0,
) -> pl.DataFrame:
    """Separate a unit's own effect from the schedule it happened to face.

    A defense that played four bad offenses looks elite until you correct for it.
    This fits `value ~ unit_effect + opponent_effect` by ridge-regularized least
    squares: each observation is explained by both parties, and the regularizer
    shrinks thin samples toward zero rather than letting a two-game unit post a
    wild rating.

    Returns one row per unit with its adjusted effect, in the same units as
    `value_col`, centred on the league mean.
    """
    units = observations[unit_col].unique().sort().to_list()
    opponents = observations[opponent_col].unique().sort().to_list()

    unit_index = {u: i for i, u in enumerate(units)}
    opponent_index = {o: i + len(units) for i, o in enumerate(opponents)}

    n_rows = observations.height
    n_cols = len(units) + len(opponents)

    design = np.zeros((n_rows, n_cols))
    for row_number, row in enumerate(observations.iter_rows(named=True)):
        design[row_number, unit_index[row[unit_col]]] = 1.0
        design[row_number, opponent_index[row[opponent_col]]] = 1.0

    values = observations[value_col].to_numpy().astype(float)
    league_mean = float(values.mean())
    centred = values - league_mean

    # Ridge closed form: (X'X + lambda I)^-1 X'y
    gram = design.T @ design + ridge * np.eye(n_cols)
    coefficients = np.linalg.solve(gram, design.T @ centred)

    return pl.DataFrame(
        {
            unit_col: units,
            "raw": [
                float(observations.filter(pl.col(unit_col) == u)[value_col].mean()) for u in units
            ],
            "adjusted": [league_mean + float(coefficients[unit_index[u]]) for u in units],
        }
    ).sort("adjusted")
