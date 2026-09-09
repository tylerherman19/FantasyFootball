"""v2-sumer — v1's projections, matchup-adjusted from SumerSports defensive EPA.

Same shape as v2_matchup — a shrunk, capped, position-group multiplier on v1's
mean — but the defense ranking comes from SumerSports' prior-season defensive
EPA/Play splits instead of opponent-adjusted points allowed:

    QB / WR / TE  face the pass number (def EPA/Pass allowed)
    RB            faces the rush number (def EPA/Rush allowed)

EPA is the play-level version of the question v2 asks at points level, and it
is what the user asked to see weighted as the primary matchup signal
(2026-09-09). The honest read on mechanism: v2's points-allowed version lost
its ladder sweep monotonically — volume dominates matchup once usage is
projected — so this model's job is to find out whether a *better-measured*
matchup changes that verdict, not to assume it.

Difference in units, and why: v2's gaps are ratios of points (always positive,
so ratio-to-mean is natural). EPA allowed is signed — good defenses go
negative — so the gap here is a z-score across the 32 teams, scaled so a
defense two standard deviations from average hits the same 0.85/1.15 cap at
weight 1.0 that v2 uses. Same shrink-then-clamp discipline, expressed in sd.

The ladder (`model/backtest/run_ladder.py` with v2-sumer entries) decides
whether this ships, at which weight, or not at all. Report the sweep shape,
including if the higher weight hurts — that was the explicit ask.
"""

from __future__ import annotations

import numpy as np
import polars as pl

from model.backtest.harness import Prediction
from model.features.store import AsOf, FeatureStore
from model.features.sumer import team_epa_prior
from model.models.v2_matchup import apply_matchup

#: Same bounds as v2: no matchup, however measured, moves a projection by half.
MIN_MULTIPLIER = 0.85
MAX_MULTIPLIER = 1.15

#: Full cap distance at weight 1.0 for a defense this many sd from average.
CAP_Z = 2.0

#: Which defensive EPA split each fantasy position faces.
POSITION_SPLIT = {"QB": "def_epa_pass", "WR": "def_epa_pass", "TE": "def_epa_pass",
                  "RB": "def_epa_rush"}


def sumer_multipliers(
    store: FeatureStore, as_of: AsOf, weight: float = 0.35
) -> dict[tuple[str, str], float]:
    """Multiplier per (defense, position), centred on 1.0, from prior-season
    SumerSports defensive EPA. Empty when the prior season predates the feed -
    the model then degrades to plain v1 rather than guessing."""
    priors = team_epa_prior(store, as_of)
    if priors.is_empty():
        return {}

    out: dict[tuple[str, str], float] = {}
    for position, split in POSITION_SPLIT.items():
        if split not in priors.columns:
            continue
        values = priors[split].to_numpy()
        mean = float(np.mean(values))
        sd = float(np.std(values))
        if sd <= 0:
            continue
        span = (MAX_MULTIPLIER - 1.0) / CAP_Z  # cap distance per sd at weight 1
        for row in priors.select(["team", split]).to_dicts():
            z = (float(row[split]) - mean) / sd
            shrunk = 1.0 + span * z * weight
            out[(str(row["team"]), position)] = max(MIN_MULTIPLIER, min(MAX_MULTIPLIER, shrunk))
    return out


def build(
    store: FeatureStore,
    as_of: AsOf,
    rules: dict[str, float],
    weight: float = 0.35,
) -> list[Prediction]:
    """v1's projections with the SumerSports matchup applied. Harness entry point.

    Opponent/position mapping is v2's own (schedule + completed games only);
    only the source of the multiplier differs.
    """
    from model.models import v1_usage, v2_matchup

    base = v1_usage.build(store, as_of, rules)
    if not base:
        return []

    multipliers = sumer_multipliers(store, as_of, weight=weight)
    if not multipliers:
        return base

    # Reuse v2's leak-safe opponent/position resolution verbatim.
    schedules = store.raw("schedules").pl()
    week = schedules.filter(
        (schedules["season"] == as_of.season) & (schedules["week"] == as_of.week)
    )
    opponent_of_team: dict[str, str] = {}
    for row in week.iter_rows(named=True):
        home, away = str(row["home_team"]), str(row["away_team"])
        opponent_of_team[home] = away
        opponent_of_team[away] = home

    history = store.as_of("player_stats", as_of, seasons_back=1).pl()
    if history.height == 0:
        return base
    latest = (
        history.sort(["season", "week"])
        .group_by("player_id")
        .last()
        .select(["player_id", "team", "position"])
    )
    opponent_of: dict[str, str] = {}
    position_of: dict[str, str] = {}
    for row in latest.to_dicts():
        player_id = str(row["player_id"])
        team = row["team"]
        if team is None:
            continue
        opponent = opponent_of_team.get(str(team))
        if opponent is not None:
            opponent_of[player_id] = opponent
        if row["position"] is not None:
            position_of[player_id] = str(row["position"])

    return apply_matchup(base, multipliers, opponent_of, position_of)
