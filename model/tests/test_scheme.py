from __future__ import annotations

import polars as pl

from model.features.scheme import opponent_adjust


def test_opponent_adjustment_separates_unit_from_schedule() -> None:
    """A mediocre defense that only faced bad offenses should not rate elite.

    Construct it explicitly: `weak_d` faces only `bad_o`, `strong_d` faces only
    `good_o`. Raw averages say weak_d allows fewer points. The adjustment should
    close most of that gap, because the schedule explains it.
    """
    rows = []
    # Lopsided schedules: weak_d mostly sees the bad offense, strong_d mostly
    # sees the good one.
    for _ in range(10):
        rows.append({"defense": "weak_d", "offense": "bad_o", "points": 17.0})
        rows.append({"defense": "strong_d", "offense": "good_o", "points": 24.0})
    # A few crossover games anchor the comparison — and show the truth: against
    # the same opponent, strong_d allows far less.
    for _ in range(2):
        rows.append({"defense": "weak_d", "offense": "good_o", "points": 34.0})
        rows.append({"defense": "strong_d", "offense": "bad_o", "points": 10.0})

    result = opponent_adjust(
        pl.DataFrame(rows), unit_col="defense", opponent_col="offense", value_col="points", ridge=0.5
    )
    by_team = {row["defense"]: row for row in result.to_dicts()}

    raw_gap = by_team["strong_d"]["raw"] - by_team["weak_d"]["raw"]
    adjusted_gap = by_team["strong_d"]["adjusted"] - by_team["weak_d"]["adjusted"]

    # Raw says the weak defense is better; adjusted must flip the sign.
    assert raw_gap > 0
    assert adjusted_gap < 0


def test_opponent_adjustment_is_centred_on_the_league_mean() -> None:
    rows = [
        {"defense": d, "offense": o, "points": 20.0}
        for d in ("a", "b", "c")
        for o in ("x", "y", "z")
    ]
    result = opponent_adjust(
        pl.DataFrame(rows), unit_col="defense", opponent_col="offense", value_col="points"
    )
    # Every unit is identical, so every adjusted value should sit at the mean.
    for row in result.to_dicts():
        assert abs(row["adjusted"] - 20.0) < 1e-6
