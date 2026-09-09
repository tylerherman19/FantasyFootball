"""SumerSports EPA and tendency features.

The lake mirror (model/ingest/sumersports.py) lands SumerSports' public team
tables as season-grain Parquet with no week column. That shape decides the
availability rule here, and the rule is stricter than the store's default:

  **These features read the PRIOR season's table and nothing else.**

A same-season SumerSports table is a season-to-date aggregate. The feature
store's as-of filter includes same-season rows for week-less datasets (it has
no way to truncate them), which would quietly leak weeks that haven't been
played yet into a backtest. Live, the current snapshot is legal — it was
fetched before the games being predicted — but no historical weekly snapshots
exist, so backtests must never see same-season rows. Rather than trust every
caller to remember, these builders take `AsOf` and read
`season = as_of.season - 1` exactly. A same-season request is impossible to
express through them.

What they carry that the nflverse-derived features do not:

  * Team EPA/Play splits (off/def, pass/rush) — opponent quality for matchup
    adjustments, measured at play level instead of points level.
  * Formation and personnel tendency tables with EPA by grouping — the
    offensive counterpart to scheme.py's defensive profiles. scheme.py's
    profiles come from participation data, which is post-season-only from 2024;
    SumerSports tendencies refresh weekly in-season, so mid-season drift is
    visible here before it is visible there.
"""

from __future__ import annotations

import polars as pl

from model.features.store import AsOf, FeatureStore
from model.ingest.sumersports import FIRST_SEASON

TEAM_SCHEMA = {
    "team": pl.String,
    "off_epa_play": pl.Float64,
    "def_epa_play": pl.Float64,
    "net_epa_play": pl.Float64,
    "off_epa_pass": pl.Float64,
    "off_epa_rush": pl.Float64,
    "def_epa_pass": pl.Float64,
    "def_epa_rush": pl.Float64,
    "off_success_pct": pl.Float64,
    "def_success_pct": pl.Float64,
}

TENDENCY_SCHEMA = {
    "team": pl.String,
    "grouping": pl.String,
    "plays": pl.Int64,
    "rate": pl.Float64,
    "total_epa": pl.Float64,
    "epa_rank": pl.Int64,
    "epa_pass": pl.Float64,
    "epa_rush": pl.Float64,
}


def prior_season(as_of: AsOf) -> int | None:
    """The only season these features may read. None = no table exists."""
    season = as_of.season - 1
    return season if season >= FIRST_SEASON else None


def _read_prior(store: FeatureStore, dataset: str, as_of: AsOf) -> pl.DataFrame:
    season = prior_season(as_of)
    if season is None:
        return pl.DataFrame()
    try:
        frame = store.raw(dataset).pl()
    except FileNotFoundError:
        return pl.DataFrame()
    return frame.filter(pl.col("season") == season)


def team_epa_prior(store: FeatureStore, as_of: AsOf) -> pl.DataFrame:
    """One row per team: prior-season EPA/Play splits, offense and defense.

    `net_epa_play` is off minus def allowed; positive is a good team. Empty
    frame (with schema) when the prior season predates the feed's coverage.
    """
    season = prior_season(as_of)
    off = _read_prior(store, "sumer_team_offense", as_of)
    dfn = _read_prior(store, "sumer_team_defense", as_of)
    if off.is_empty() or dfn.is_empty():
        return pl.DataFrame(schema=TEAM_SCHEMA)
    joined = off.select(
        pl.col("team"),
        pl.col("epa_play").alias("off_epa_play"),
        pl.col("epa_pass").alias("off_epa_pass"),
        pl.col("epa_rush").alias("off_epa_rush"),
        pl.col("success_pct").alias("off_success_pct"),
    ).join(
        dfn.select(
            pl.col("team"),
            pl.col("epa_play").alias("def_epa_play"),
            pl.col("epa_pass").alias("def_epa_pass"),
            pl.col("epa_rush").alias("def_epa_rush"),
            pl.col("success_pct").alias("def_success_pct"),
        ),
        on="team",
        how="inner",
    ).with_columns(
        (pl.col("off_epa_play") - pl.col("def_epa_play")).alias("net_epa_play"),
        pl.lit(season).alias("source_season"),
    )
    return joined


def tendency_prior(store: FeatureStore, as_of: AsOf, *, side: str, kind: str) -> pl.DataFrame:
    """Long frame of prior-season formation/personnel tendencies.

    side: "offense" | "defense" — the unit the tendencies describe.
    kind: "formation" | "personnel".
    """
    dataset = f"sumer_{kind}_{side}"
    frame = _read_prior(store, dataset, as_of)
    if frame.is_empty():
        return pl.DataFrame(schema=TENDENCY_SCHEMA)
    return frame.select(
        pl.col("team"), pl.col("grouping"), pl.col("plays"), pl.col("rate"),
        pl.col("total_epa"), pl.col("epa_rank"), pl.col("epa_pass"), pl.col("epa_rush"),
    )
