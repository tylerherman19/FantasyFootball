"""Measure what an injury designation actually means.

`packages/core/src/projections/availability.ts` prices designations from a
hand-set table — Questionable 0.72, Doubtful 0.25, COV 0.35 — and those numbers
do two jobs at once: they decide whether a player reaches the lineup solver, and
they scale every projection the simulator draws. They are among the most
load-bearing constants in the product and nobody measured them.

The injury reports go back to 2016 and `player_stats` records who actually
appeared, so this is a join, not a model.

**Two quantities, not one.** The obvious one is the play rate: of players listed
Questionable, what share suited up. The one almost nobody prices is the
*production* conditional on playing — a Questionable receiver who plays is
playing hurt, and he does not produce like himself. Treating "he played" as "he
was fine" overstates every hurt starter in every lineup decision, and it does it
in the direction that loses leagues, because the manager starts him.

So both are exported: `playRate`, and `productionRatio` — his output in the
weeks he was listed, against his own baseline in the weeks he was not. Comparing
a player to himself is deliberate; comparing hurt players to healthy ones would
mostly measure that better players get listed less.

    uv run --project model python model/export_availability.py
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import polars as pl

from model.backtest.harness import SKILL_POSITIONS, default_lake
from model.export_projections import current_week
from model.features.store import AsOf, FeatureStore

#: Reference scoring, only to have one production number per player-week.
#: Never exported: the app scores stat lines per league.
_RULES: dict[str, float] = {
    "passing_yards": 0.04, "passing_tds": 4.0, "passing_interceptions": -1.0,
    "rushing_yards": 0.1, "rushing_tds": 6.0,
    "receptions": 1.0, "receiving_yards": 0.1, "receiving_tds": 6.0,
}

#: Minimum observations before a designation's play rate is trusted.
MIN_OBSERVATIONS = 100

#: Minimum players who actually appeared before a *production* ratio is
#: reported. The play rate and the production ratio have very different
#: effective samples: of 3,232 players listed Out, exactly one recorded a stat
#: line, so a production ratio computed from that row is a single afternoon
#: masquerading as a finding. Doubtful has four. Only Questionable clears this,
#: and it is the only one that should carry a number.
MIN_PLAYED = 200

#: Designations worth reporting separately. Anything rarer is pooled into the
#: table's own fallback rather than fitted on a handful of rows.
TRACKED = ("Out", "Doubtful", "Questionable")


def build_artifact(season: int, week: int, lake: Path) -> dict:
    with FeatureStore(lake) as store:
        as_of = AsOf(season, week)
        injuries = store.as_of("injuries", as_of, seasons_back=12).pl()
        stats = store.as_of("player_stats", as_of, seasons_back=12).pl()

    if injuries.height == 0 or stats.height == 0:
        raise SystemExit("no injury reports or player stats available")

    terms = [
        pl.col(stat).cast(pl.Float64).fill_null(0.0) * weight
        for stat, weight in _RULES.items()
        if stat in stats.columns
    ]
    if not terms:
        raise SystemExit("player_stats is missing the scoring columns")

    appeared = (
        stats.filter(pl.col("position").is_in(SKILL_POSITIONS))
        .with_columns(pl.sum_horizontal(terms).alias("points"))
        .select(
            pl.col("player_id").cast(pl.Utf8),
            pl.col("position").cast(pl.Utf8),
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            pl.col("points"),
        )
    )

    listed = (
        injuries.filter(
            pl.col("gsis_id").is_not_null()
            & pl.col("report_status").is_not_null()
            & pl.col("position").is_in(SKILL_POSITIONS)
        )
        .select(
            pl.col("gsis_id").cast(pl.Utf8).alias("player_id"),
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            pl.col("report_status").cast(pl.Utf8).alias("status"),
        )
        .unique(subset=["player_id", "season", "week"])
    )
    if listed.height == 0:
        raise SystemExit("no report statuses in the injury feed")

    # Left join: a listed player with no stat line did not appear.
    joined = listed.join(appeared, on=["player_id", "season", "week"], how="left").with_columns(
        pl.col("points").is_not_null().cast(pl.Float64).alias("played")
    )

    # Each player's own baseline: his mean in the weeks he carried no
    # designation. Comparing him to himself, because comparing hurt players to
    # healthy ones would mostly measure that better players get listed less.
    healthy = (
        appeared.join(listed, on=["player_id", "season", "week"], how="anti")
        .group_by("player_id")
        .agg(pl.col("points").mean().alias("baseline"), pl.len().alias("healthy_weeks"))
        .filter(pl.col("healthy_weeks") >= 8)
    )

    with_baseline = (
        joined.filter(pl.col("played") == 1)
        .join(healthy, on="player_id", how="inner")
        .filter(pl.col("baseline") > 3.0)
        .with_columns((pl.col("points") / pl.col("baseline")).alias("ratio"))
    )

    play_rates = joined.group_by("status").agg(
        pl.len().alias("observations"), pl.col("played").mean().alias("playRate")
    )
    production = with_baseline.group_by("status").agg(
        pl.len().alias("playedObservations"),
        # Median: production ratios are right-skewed and one three-touchdown
        # afternoon should not tell us that being hurt helps.
        pl.col("ratio").median().alias("productionRatio"),
    )

    merged = play_rates.join(production, on="status", how="left")

    statuses: dict[str, dict] = {}
    for row in merged.sort("status").to_dicts():
        status = str(row["status"])
        observations = int(row["observations"])
        if observations < MIN_OBSERVATIONS:
            continue
        statuses[status] = {
            "status": status,
            "observations": observations,
            "playRate": round(float(row["playRate"]), 4),
            "playedObservations": int(row["playedObservations"] or 0),
            "productionRatio": (
                round(float(row["productionRatio"]), 4)
                if row["productionRatio"] is not None
                and int(row["playedObservations"] or 0) >= MIN_PLAYED
                else None
            ),
        }

    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "season": season,
        "week": week,
        "note": (
            "playRate is the share of listed players who recorded a stat line. "
            "productionRatio is their output in listed weeks against their own "
            "baseline in unlisted weeks — a player compared to himself, because "
            "comparing hurt players to healthy ones mostly measures that better "
            "players get listed less often."
        ),
        "statuses": statuses,
    }


if __name__ == "__main__":
    default_season, default_week = current_week()
    season = int(sys.argv[1]) if len(sys.argv) > 1 else default_season
    week = int(sys.argv[2]) if len(sys.argv) > 2 else default_week

    artifact = build_artifact(season, week, default_lake())
    out = Path("model/artifacts/availability.json")
    out.write_text(json.dumps(artifact, indent=2, sort_keys=True), encoding="utf-8")

    print(f"wrote {out.name}")
    print(f"  {'status':14s} {'n':>7s} {'play rate':>10s} {'production':>11s}")
    for status in sorted(artifact["statuses"], key=lambda s: -artifact["statuses"][s]["playRate"]):
        row = artifact["statuses"][status]
        ratio = row["productionRatio"]
        print(
            f"  {status:14s} {row['observations']:7,d} {row['playRate']:10.3f} "
            f"{(f'{ratio:.3f}' if ratio is not None else '—'):>11s}"
        )
