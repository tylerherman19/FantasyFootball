"""Measured within-team correlation, by position pair.

The portfolio view models co-movement with a single factor: each player has a
`gameLoading`, and two players in the same game correlate by the product of
their factor loadings. That is a real model and it is not enough, for a reason
worth stating precisely.

One factor can only represent a **shared environment** — a shootout lifts
everyone, a defensive struggle sinks everyone. It cannot represent a *direct
dependency*, and the most important correlation in fantasy football is exactly
that: a quarterback throws the passes his receiver catches. Their fates are
linked by the same completions, not merely by the same scoreboard.

Measured against the scoreboard, quarterbacks load at 0.178 and receivers at
0.031, which gives a modelled QB-WR correlation of `sqrt(0.178 x 0.031) = 0.074`.
Nobody who has played fantasy football believes a quarterback and his WR1 are
7% correlated. The one-factor model is not wrong so much as blind to the channel
that matters.

So this measures the thing directly. For every pair of skill players on the same
team in the same week, take each one's deviation from his own mean and correlate
them, grouped by position pair. That is the joint distribution the audit said was
needed — at position-pair resolution rather than player-pair, which is what the
sample can actually support.

Two decisions worth naming:

- **Centred per player, per season.** Otherwise the correlation is dominated by
  good players being good, which is not co-movement.
- **Ordered pairs are collapsed.** QB-WR and WR-QB are the same fact.

    uv run --project model python model/export_correlation.py
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from itertools import combinations
from pathlib import Path

import polars as pl

from model.backtest.harness import SKILL_POSITIONS, default_lake
from model.features.store import FeatureStore

FIRST_SEASON = 2016

#: A player needs enough weeks for his own mean to be a baseline rather than a
#: restatement of the weeks being measured.
MIN_PLAYER_WEEKS = 8

#: Pairs below this are noise.
MIN_PAIRS = 400

#: Reference scoring, only to have one number per player-week.
_RULES: dict[str, float] = {
    "passing_yards": 0.04, "passing_tds": 4.0, "passing_interceptions": -1.0,
    "rushing_yards": 0.1, "rushing_tds": 6.0,
    "receptions": 1.0, "receiving_yards": 0.1, "receiving_tds": 6.0,
}


def measure(store: FeatureStore) -> dict[str, dict[str, float | int]]:
    stats = store.raw("player_stats").pl()
    if stats.height == 0:
        raise SystemExit("player_stats is empty")

    terms = [
        pl.col(stat).cast(pl.Float64).fill_null(0.0) * weight
        for stat, weight in _RULES.items()
        if stat in stats.columns
    ]

    frame = (
        stats.filter(
            (pl.col("season") >= FIRST_SEASON)
            & pl.col("position").is_in(SKILL_POSITIONS)
            & pl.col("team").is_not_null()
        )
        .with_columns(pl.sum_horizontal(terms).alias("points"))
        .select(
            pl.col("player_id").cast(pl.Utf8),
            pl.col("position").cast(pl.Utf8),
            pl.col("team").cast(pl.Utf8),
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            pl.col("points"),
        )
    )

    # Per player *per season*: a role can change completely between years, and
    # centring across both would read that change as co-movement.
    per_player = frame.group_by(["player_id", "season"]).agg(
        pl.col("points").mean().alias("player_mean"), pl.len().alias("weeks")
    )
    centred = (
        frame.join(per_player, on=["player_id", "season"], how="inner")
        .filter(pl.col("weeks") >= MIN_PLAYER_WEEKS)
        .with_columns((pl.col("points") - pl.col("player_mean")).alias("deviation"))
        .select(["player_id", "position", "team", "season", "week", "deviation"])
    )

    # Self-join on team-week gives every co-occurring pair. Filtering to
    # player_id < player_id keeps one row per unordered pair and drops self-pairs.
    left = centred.rename({c: f"{c}_a" for c in ["player_id", "position", "deviation"]})
    right = centred.rename({c: f"{c}_b" for c in ["player_id", "position", "deviation"]})

    pairs = (
        left.join(right, on=["team", "season", "week"], how="inner")
        .filter(pl.col("player_id_a") < pl.col("player_id_b"))
        .select(["position_a", "position_b", "deviation_a", "deviation_b"])
    )
    if pairs.height == 0:
        raise SystemExit("no co-occurring pairs found")

    out: dict[str, dict[str, float | int]] = {}

    for first, second in list(combinations(SKILL_POSITIONS, 2)) + [(p, p) for p in SKILL_POSITIONS]:
        # Collapse ordering: QB-WR and WR-QB are the same fact.
        subset = pairs.filter(
            ((pl.col("position_a") == first) & (pl.col("position_b") == second))
            | ((pl.col("position_a") == second) & (pl.col("position_b") == first))
        )
        if subset.height < MIN_PAIRS:
            continue

        r = subset.select(pl.corr("deviation_a", "deviation_b").alias("r"))["r"][0]
        if r is None:
            continue

        key = "-".join(sorted([first, second]))
        out[key] = {"correlation": round(float(r), 4), "pairs": int(subset.height)}

    return out


def main() -> None:
    with FeatureStore(default_lake()) as store:
        measured = measure(store)

    payload = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "firstSeason": FIRST_SEASON,
        "method": (
            "Pearson correlation of weekly fantasy-point deviations between "
            "every pair of skill players on the same team in the same week, "
            "each centred on his own mean for that season. Grouped by position "
            "pair, which is the resolution the sample supports."
        ),
        "why": (
            "A one-factor game-environment model can only represent a shared "
            "environment. It cannot represent a direct dependency, and the "
            "quarterback-to-receiver link is exactly that: he throws the passes "
            "the receiver catches. The factor model implied 0.074 for QB-WR; "
            "this measures it."
        ),
        "pairs": measured,
    }

    out = Path(__file__).resolve().parents[0] / "artifacts" / "correlation.json"
    out.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    print(f"wrote {out.name}")
    print(f"  {'pair':10s} {'r':>8s} {'n':>10s}")
    for key in sorted(measured, key=lambda k: -float(measured[k]["correlation"])):
        row = measured[key]
        print(f"  {key:10s} {float(row['correlation']):8.3f} {int(row['pairs']):10,d}")


if __name__ == "__main__":
    main()
