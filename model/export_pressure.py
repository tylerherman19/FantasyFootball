"""Blitz and box tendencies, the half of a defense play-by-play cannot see.

`export_defense.py` measures a defense by its *consequences* — depth of target
allowed, deep rate, YAC share, yards per carry — and argues, correctly, that a
manager cares whether a defense in fact allows nothing deep rather than what
shell it lined up in. That argument holds for coverage, where the consequence is
directly observable.

It does not hold for pressure. Whether a defense sends five is not recoverable
from a box score: a sack is charged the same way whether it came from a
four-man rush beating protection or a corner blitz nobody blocked, and those two
facts predict opposite things about the quarterback who faces them next. The
brief asks for both (§14), and this is the half that needs charting.

FTN charting supplies it — `n_blitzers`, `n_pass_rushers`, `n_defense_box` —
across 2022-2025, and it is legal at inference: unlike the retired
`pbp_participation` release, FTN is refreshed during the season and a play
becomes knowable once its game completes.

Four dimensions, each a rate rather than a count so teams that played more games
are not flattered:

- **Blitz rate** — at least one defender rushing who is not a lineman.
- **Extra-rusher rate** — five or more pass rushers, which is the version that
  actually breaks protections.
- **Box count** — average defenders in the box, the single best read on whether
  a defense is inviting the run or daring the pass.
- **Light-box rate** — six or fewer, the two-high signature from the other side.

Opponent adjustment is deliberately *not* applied. These are choices a
coordinator makes, and he makes them against good offences and bad ones alike;
dividing out the schedule would subtract signal. That is the same reasoning the
offensive export uses, and the opposite of what the efficiency-allowed numbers
in `export_defense.py` require.

    uv run --project model python model/export_pressure.py
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

#: Five or more rushers is the threshold where protection maths actually breaks:
#: five blockers cannot account for six, so someone comes free or the ball goes
#: out early. Four-man pressure is a different phenomenon and is not this.
EXTRA_RUSHER_THRESHOLD = 5

#: Six or fewer in the box is the light-box signature — the run is invited.
LIGHT_BOX_MAX = 6

#: Eight or more is loaded up against the run, daring the pass.
HEAVY_BOX_MIN = 8

#: Seasons of charting to pool. Coordinators and personnel turn over, so a long
#: window measures a team that no longer exists.
SEASONS_BACK = 2


def build_artifact(season: int, week: int, lake: Path) -> dict:
    with FeatureStore(lake) as store:
        charting = store.as_of("ftn_charting", as_of := AsOf(season, week), seasons_back=SEASONS_BACK).pl()
        pbp = store.as_of("pbp", as_of, seasons_back=SEASONS_BACK).pl()

    if charting.height == 0 or pbp.height == 0:
        raise SystemExit("no charting or play-by-play available")

    # FTN keys plays by nflverse ids, so the defense comes from the join rather
    # than from the charting itself.
    plays = pbp.select(
        pl.col("game_id").cast(pl.Utf8).alias("nflverse_game_id"),
        pl.col("play_id").cast(pl.Float64).alias("nflverse_play_id"),
        pl.col("defteam").cast(pl.Utf8),
        pl.col("pass").cast(pl.Float64).alias("is_pass_play"),
    ).drop_nulls("defteam")

    joined = charting.select(
        pl.col("nflverse_game_id").cast(pl.Utf8),
        pl.col("nflverse_play_id").cast(pl.Float64),
        pl.col("n_blitzers").cast(pl.Float64),
        pl.col("n_pass_rushers").cast(pl.Float64),
        pl.col("n_defense_box").cast(pl.Float64),
    ).join(plays, on=["nflverse_game_id", "nflverse_play_id"], how="inner")

    if joined.height == 0:
        raise SystemExit("charting did not join to play-by-play — check id types")

    # Blitz and rusher counts only mean anything on a pass play.
    passes = joined.filter(pl.col("is_pass_play") == 1).drop_nulls("n_pass_rushers")

    # A box count of zero is FTN's not-charted sentinel, not a defense with
    # nobody in the box — which is not a thing. Roughly a quarter of charted
    # rows carry it, and averaging them in dragged the league mean from about
    # 6.5 defenders down to 4.9, which would have shipped as a plausible-looking
    # number that was simply wrong. Treated as missing, which is what it is.
    boxes = joined.drop_nulls("n_defense_box").filter(pl.col("n_defense_box") > 0)

    pressure = passes.group_by("defteam").agg(
        pl.len().alias("dropbacksFaced"),
        (pl.col("n_blitzers") >= 1).cast(pl.Float64).mean().alias("blitzRate"),
        (pl.col("n_pass_rushers") >= EXTRA_RUSHER_THRESHOLD)
        .cast(pl.Float64)
        .mean()
        .alias("extraRusherRate"),
        pl.col("n_pass_rushers").mean().alias("passRushers"),
    )

    box = boxes.group_by("defteam").agg(
        pl.col("n_defense_box").mean().alias("boxCount"),
        (pl.col("n_defense_box") <= LIGHT_BOX_MAX).cast(pl.Float64).mean().alias("lightBoxRate"),
        (pl.col("n_defense_box") >= HEAVY_BOX_MIN).cast(pl.Float64).mean().alias("heavyBoxRate"),
    )

    merged = pressure.join(box, on="defteam", how="left")

    def percentiles(column: str) -> dict[str, float]:
        values = {
            canonical_team(r["defteam"]): float(r[column])
            for r in merged.to_dicts()
            if r.get(column) is not None
        }
        if not values:
            return {}
        ordered = sorted(values.values())
        span = max(1, len(ordered) - 1)
        return {
            team: round(sum(1 for v in ordered if v < value) / span, 4)
            for team, value in values.items()
        }

    blitz_pct = percentiles("blitzRate")
    box_pct = percentiles("boxCount")

    teams: dict[str, dict] = {}
    for row in merged.to_dicts():
        team = canonical_team(row["defteam"])
        if not team:
            continue
        teams[team] = {
            "team": team,
            "dropbacksFaced": int(row["dropbacksFaced"]),
            "blitzRate": round(float(row["blitzRate"] or 0.0), 4),
            "blitzRatePct": blitz_pct.get(team),
            "extraRusherRate": round(float(row["extraRusherRate"] or 0.0), 4),
            "passRushers": round(float(row["passRushers"] or 0.0), 3),
            "boxCount": round(float(row["boxCount"]), 3) if row.get("boxCount") is not None else None,
            "boxCountPct": box_pct.get(team),
            "lightBoxRate": (
                round(float(row["lightBoxRate"]), 4) if row.get("lightBoxRate") is not None else None
            ),
            "heavyBoxRate": (
                round(float(row["heavyBoxRate"]), 4) if row.get("heavyBoxRate") is not None else None
            ),
        }

    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "season": season,
        "week": week,
        "seasonsBack": SEASONS_BACK,
        "teamCount": len(teams),
        "note": (
            "Blitz and box tendencies are coordinator choices, made against good "
            "offences and bad ones alike, so they are deliberately not "
            "opponent-adjusted. The efficiency-allowed numbers in "
            "defense-scheme.json are adjusted, because those are outcomes."
        ),
        "teams": teams,
    }


if __name__ == "__main__":
    default_season, default_week = current_week()
    season = int(sys.argv[1]) if len(sys.argv) > 1 else default_season
    week = int(sys.argv[2]) if len(sys.argv) > 2 else default_week

    artifact = build_artifact(season, week, default_lake())
    out = Path("model/artifacts/defense-pressure.json")
    out.write_text(json.dumps(artifact, separators=(",", ":"), sort_keys=True), encoding="utf-8")

    print(f"{out}: {artifact['teamCount']} defenses")
    ranked = sorted(artifact["teams"].values(), key=lambda t: t["blitzRate"], reverse=True)
    print(f"  {'team':5s} {'blitz':>7s} {'5+ rush':>8s} {'box':>6s} {'light':>7s}")
    for team in [*ranked[:3], *ranked[-3:]]:
        print(
            f"  {team['team']:5s} {team['blitzRate']:7.3f} {team['extraRusherRate']:8.3f} "
            f"{(team['boxCount'] or 0):6.2f} {(team['lightBoxRate'] or 0):7.3f}"
        )
