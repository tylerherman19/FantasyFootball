"""The rookie prior's invariants, tested on fixtures rather than on the lake.

The properties that matter are structural — a curve must fall with draft slot,
a prior must not exceed what premium picks actually do, a deeper depth chart
rank must not earn more work — and none of them need real data to check.
"""

from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from model.models import rookie_prior as rp


def test_normalize_name_strips_punctuation_and_suffixes():
    assert rp.normalize_name("Ja'Marr Chase") == "jamarr chase"
    assert rp.normalize_name("Marvin Harrison Jr.") == "marvin harrison"
    assert rp.normalize_name("Michael Pittman  Jr") == "michael pittman"
    assert rp.normalize_name("Amon-Ra St. Brown") == "amon ra st brown"


def _synthetic(n: int = 200, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Volume that genuinely decays with draft slot, plus noise."""
    rng = np.random.default_rng(seed)
    picks = np.linspace(1, 257, n)
    values = np.maximum(0.0, 18.0 * np.exp(-picks / 60.0) + rng.normal(0, 0.5, n))
    return picks, values


def test_curve_decreases_with_draft_slot():
    picks, values = _synthetic()
    curve = rp._fit_curve("RB", "carries", picks, values)

    assert curve.slope < 0
    assert curve.predict(1) > curve.predict(32) > curve.predict(100) > curve.predict(258)


def test_curve_never_exceeds_what_premium_picks_actually_did():
    """The guard against extrapolating a log-log fit back past its own data.

    Uncapped, this fit claimed 64 carries a game for a first-overall back.
    """
    picks, values = _synthetic()
    curve = rp._fit_curve("RB", "carries", picks, values)

    premium = float(values[picks <= 10].mean())
    assert curve.predict(1) <= premium + 1e-9
    assert curve.ceiling == pytest.approx(premium)


def test_thin_sample_falls_back_to_a_flat_mean_rather_than_a_fitted_slope():
    picks = np.array([1.0, 40.0, 90.0])
    values = np.array([5.0, 3.0, 1.0])
    curve = rp._fit_curve("TE", "targets", picks, values)

    assert curve.slope == 0.0
    assert curve.predict(1) == curve.predict(200)


def test_an_inverted_slope_is_rejected_rather_than_shipped():
    """Later picks cannot out-earn earlier ones across a whole class."""
    picks = np.linspace(1, 257, 120)
    values = picks / 40.0  # deliberately backwards
    curve = rp._fit_curve("WR", "targets", picks, values)

    assert curve.slope == 0.0
    assert curve.r2 == 0.0


def test_premium_mean_widens_to_round_one_when_the_top_ten_is_thin():
    # Twelve first-rounders, two of them top-ten: too few for the first tier,
    # enough for the second, so the second is what gets averaged.
    picks = np.array([5.0, 8.0, 14.0, 18.0, 20.0, 22.0, 24.0, 26.0, 28.0, 30.0, 31.0, 32.0, 90.0])
    values = np.arange(13.0, 0.0, -1.0)

    assert rp._premium_pick_mean(picks, values) == pytest.approx(
        float(values[picks <= 32].mean())
    )


def test_premium_mean_never_falls_back_to_the_observed_maximum():
    """The thin-sample case is where a max-based ceiling is least defensible."""
    picks = np.array([5.0, 12.0, 40.0, 90.0, 120.0, 150.0, 200.0, 250.0])
    values = np.array([10.0, 6.0, 8.0, 5.0, 4.0, 3.0, 2.0, 1.0])

    ceiling = rp._premium_pick_mean(picks, values)

    # Every tier is too thin, so it averages the earliest-drafted quartile —
    # two picks here — rather than reaching for the single best season.
    assert ceiling == pytest.approx(8.0)
    assert ceiling < float(values.max())


def test_undrafted_players_are_priced_below_every_drafted_pick():
    """Undrafted is a real answer, not a missing one: one slot past the end."""
    picks, values = _synthetic()
    curve = rp._fit_curve("WR", "targets", picks, values)

    undrafted = curve.predict(rp.DRAFT_SIZE + 1)

    assert undrafted < curve.predict(rp.DRAFT_SIZE)
    assert undrafted > 0.0


class _FakeStore:
    """Just enough of FeatureStore for the depth-chart helpers."""

    def __init__(self, **datasets: pl.DataFrame) -> None:
        self._datasets = datasets

    def raw(self, dataset: str, **_: object):
        frame = self._datasets.get(dataset)
        if frame is None:
            raise FileNotFoundError(dataset)
        return _Relation(frame)


class _Relation:
    def __init__(self, frame: pl.DataFrame) -> None:
        self._frame = frame

    @property
    def columns(self) -> list[str]:
        return self._frame.columns

    def pl(self) -> pl.DataFrame:
        return self._frame


def _depth_fixture(rank4_carries: float) -> tuple[_FakeStore, pl.DataFrame]:
    """120 rookie backs across four depth ranks, thirty at each."""
    per_rank = [14.0, 7.0, 2.0, rank4_carries]
    carries = [value for value in per_rank for _ in range(30)]
    ranks = [rank for rank in (1, 2, 3, 4) for _ in range(30)]
    ids = [f"p{i}" for i in range(120)]

    rookies = pl.DataFrame(
        {
            "player_id": ids,
            "position": ["RB"] * 120,
            "season": [2024] * 120,
            "attempts": [0.0] * 120,
            "carries": carries,
            "targets": [0.0] * 120,
        }
    )
    charts = pl.DataFrame(
        {"gsis_id": ids, "season": [2024] * 120, "week": [1] * 120, "pos_rank": ranks}
    )
    return _FakeStore(depth_charts=charts), rookies


def test_depth_multipliers_track_opportunity():
    store, rookies = _depth_fixture(rank4_carries=1.0)
    out = rp._depth_multipliers(store, rp.AsOf(2025, 1), rookies)

    assert out[("RB", 1)] > 1.0
    assert out[("RB", 3)] < 1.0


def test_depth_multipliers_never_rise_as_the_chart_deepens():
    """The monotonicity constraint, which the raw estimates violate in the tail.

    Fourth-string backs measured *above* second-string ones in the real data.
    That is sample noise, and being listed deeper cannot earn more work.
    """
    store, rookies = _depth_fixture(rank4_carries=9.0)  # noisier than rank 2
    out = rp._depth_multipliers(store, rp.AsOf(2025, 1), rookies)

    values = [out[("RB", rank)] for rank in (1, 2, 3, 4)]
    assert values == sorted(values, reverse=True)
    assert out[("RB", 4)] <= out[("RB", 2)]


def test_depth_ranks_reads_both_nflverse_schemas():
    """2024-25 carry `season`/`week`; 2026 carries `dt`. Unioned, each is null
    in the other's rows — and reading one alone yields an empty join, silently.
    """
    charts = pl.DataFrame(
        {
            "gsis_id": ["old", "new"],
            "season": [2025, None],
            "week": [1, None],
            "dt": [None, "2026-08-17T07:46:40Z"],
            "pos_rank": [2, 1],
        },
        schema_overrides={"season": pl.Int32, "week": pl.Int32},
    )

    ranks = rp._depth_ranks(_FakeStore(depth_charts=charts), rp.AsOf(2026, 1))
    seasons = dict(zip(ranks["player_id"].to_list(), ranks["season"].to_list(), strict=True))

    assert seasons == {"old": 2025, "new": 2026}


def test_depth_ranks_is_empty_without_the_dataset():
    assert rp._depth_ranks(_FakeStore(), rp.AsOf(2026, 1)).height == 0
