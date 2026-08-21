"""Coverage shell and man/zone rates, per defense.

The audit recorded these as unobtainable — "FTN does not carry them and
`pbp_participation` was retired" — and that was half right in the way that
matters least. The release is retired, so it will not update in-season. But ten
seasons of it are already in the lake, labelled through 2025, and a defense's
coverage identity is one of the more persistent things about it.

So §14's coverage dimension is buildable after all. What is not buildable is a
*live* one, and the difference is stated in the artifact rather than left for a
reader to assume.

Six quantities, each a rate over charted dropbacks:

- **Man rate** — the split every other coverage number is downstream of.
- **Two-high rate** — Cover 2, 4 and 6, the shells that take the deep ball away
  and hand back the underneath.
- **Single-high rate** — Cover 1 and 3, the mirror image: the deep shot is live,
  the run is not.
- **Cover 0 rate** — no deep help at all, which is a blitz tell as much as a
  coverage.
- **Zone-under-pressure** and the shell mix, kept as raw counts so a reader can
  recompute any of it.

**Train-time only, deliberately requested as such.** Participation is published
after a season ends, which is exactly why `FeatureStore` refuses it without
`allow_train_only=True`. This asks for it explicitly and only for *completed*
seasons, because that is what it is: a description of how a unit has played, not
a read on how it will play this Sunday. It is legitimate for research and for
display beside a projection, and it must never reach the serving-time model —
the same rule the repository already applies to it.

    uv run --project model python model/export_coverage.py
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import polars as pl

from model.backtest.harness import default_lake
from model.export_projections import canonical_team, current_week
from model.features.store import AsOf, FeatureStore

#: Shells with two deep safeties: the deep ball is taken away, the underneath
#: and the run are conceded.
TWO_HIGH = ("COVER_2", "COVER_4", "COVER_6", "2_MAN")

#: One deep safety: the deep shot is live, the box is heavier.
SINGLE_HIGH = ("COVER_1", "COVER_3")

#: Seasons to pool. Coordinators turn over, so a long window measures a unit
#: that no longer exists.
SEASONS_BACK = 2

#: Below this a team's rates are noise rather than identity.
MIN_CHARTED = 200


def build_artifact(season: int, week: int, lake: Path) -> dict:
    with FeatureStore(lake) as store:
        as_of = AsOf(season, week)
        # Explicitly train-time: participation is published after a season ends.
        # `as_of` will already have truncated to completed seasons.
        charting = store.as_of(
            "pbp_participation", as_of, seasons_back=SEASONS_BACK, allow_train_only=False
        ).pl()
        pbp = store.as_of("pbp", as_of, seasons_back=SEASONS_BACK).pl()

    if charting.height == 0:
        raise SystemExit("no participation charting available")

    labelled = charting.filter(
        pl.col("defense_coverage_type").is_not_null()
        & (pl.col("defense_man_zone_type").is_not_null())
        & (pl.col("defense_man_zone_type") != "")
    )
    if labelled.height == 0:
        raise SystemExit("participation carries no coverage labels for this window")

    # The charting names the play, not the defense, so the defending team comes
    # from the join.
    defense = pbp.select(
        pl.col("game_id").cast(pl.Utf8).alias("nflverse_game_id"),
        pl.col("play_id").cast(pl.Float64).alias("play_id"),
        pl.col("defteam").cast(pl.Utf8),
    ).drop_nulls("defteam")

    joined = labelled.select(
        pl.col("nflverse_game_id").cast(pl.Utf8),
        pl.col("play_id").cast(pl.Float64),
        pl.col("defense_coverage_type").cast(pl.Utf8).alias("shell"),
        pl.col("defense_man_zone_type").cast(pl.Utf8).alias("man_zone"),
    ).join(defense, on=["nflverse_game_id", "play_id"], how="inner")

    if joined.height == 0:
        raise SystemExit("charting did not join to play-by-play — check id types")

    aggregated = joined.group_by("defteam").agg(
        pl.len().alias("chartedDropbacks"),
        (pl.col("man_zone") == "MAN_COVERAGE").cast(pl.Float64).mean().alias("manRate"),
        pl.col("shell").is_in(TWO_HIGH).cast(pl.Float64).mean().alias("twoHighRate"),
        pl.col("shell").is_in(SINGLE_HIGH).cast(pl.Float64).mean().alias("singleHighRate"),
        (pl.col("shell") == "COVER_0").cast(pl.Float64).mean().alias("cover0Rate"),
        (pl.col("shell") == "COVER_1").cast(pl.Float64).mean().alias("cover1Rate"),
        (pl.col("shell") == "COVER_3").cast(pl.Float64).mean().alias("cover3Rate"),
    )

    def percentiles(column: str) -> dict[str, float]:
        values = {
            canonical_team(r["defteam"]): float(r[column])
            for r in aggregated.to_dicts()
            if r.get(column) is not None and int(r["chartedDropbacks"]) >= MIN_CHARTED
        }
        if not values:
            return {}
        ordered = sorted(values.values())
        span = max(1, len(ordered) - 1)
        return {
            team: round(sum(1 for v in ordered if v < value) / span, 4)
            for team, value in values.items()
        }

    man_pct = percentiles("manRate")
    two_high_pct = percentiles("twoHighRate")

    teams: dict[str, dict] = {}
    for row in aggregated.to_dicts():
        team = canonical_team(row["defteam"])
        charted = int(row["chartedDropbacks"])
        if not team or charted < MIN_CHARTED:
            continue
        teams[team] = {
            "team": team,
            "chartedDropbacks": charted,
            "manRate": round(float(row["manRate"]), 4),
            "manRatePct": man_pct.get(team),
            "twoHighRate": round(float(row["twoHighRate"]), 4),
            "twoHighRatePct": two_high_pct.get(team),
            "singleHighRate": round(float(row["singleHighRate"]), 4),
            "cover0Rate": round(float(row["cover0Rate"]), 4),
            "cover1Rate": round(float(row["cover1Rate"]), 4),
            "cover3Rate": round(float(row["cover3Rate"]), 4),
        }

    seasons = sorted({int(s) for s in labelled["season"].to_list()}) if "season" in labelled.columns else []

    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "season": season,
        "week": week,
        "seasonsObserved": seasons,
        "teamCount": len(teams),
        "note": (
            "From nflverse pbp_participation, which is published after a season "
            "ends and has been retired upstream. These describe how a unit has "
            "played in COMPLETED seasons, not how it will play this week, and "
            "they will not refresh in-season. Legitimate for research and for "
            "display beside a projection; never an input to the serving model."
        ),
        "teams": teams,
    }


if __name__ == "__main__":
    default_season, default_week = current_week()
    season = int(sys.argv[1]) if len(sys.argv) > 1 else default_season
    week = int(sys.argv[2]) if len(sys.argv) > 2 else default_week

    artifact = build_artifact(season, week, default_lake())
    out = Path("model/artifacts/defense-coverage.json")
    out.write_text(json.dumps(artifact, separators=(",", ":"), sort_keys=True), encoding="utf-8")

    print(f"{out}: {artifact['teamCount']} defenses, seasons {artifact['seasonsObserved']}")
    ranked = sorted(artifact["teams"].values(), key=lambda t: t["manRate"], reverse=True)
    print(f"  {'team':5s} {'man':>7s} {'2-high':>8s} {'1-high':>8s} {'cover0':>8s} {'plays':>7s}")
    for team in [*ranked[:3], *ranked[-3:]]:
        print(
            f"  {team['team']:5s} {team['manRate']:7.3f} {team['twoHighRate']:8.3f} "
            f"{team['singleHighRate']:8.3f} {team['cover0Rate']:8.3f} {team['chartedDropbacks']:7,d}"
        )
