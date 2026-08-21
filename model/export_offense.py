"""Export each offence's behaviour, and what it means for the players in it.

`model/features/team_context.py` has computed pace and PROE since Phase 4b, and
nothing has ever consumed them except `v2_matchup`, which was measured and
declined. So the features exist, are correct, and are invisible — the same
pattern as the bye export and the rookie prior before them.

This makes them serveable, and adds the one piece that was missing.

**Red-zone tendency.** Pace decides how many plays a team runs and PROE decides
how it splits them, but neither says who gets the ball inside the twenty, which
is where touchdown equity — the single noisiest and most valuable component of a
fantasy week — is actually assigned. A back on a team that runs 62% of its
red-zone snaps is in a different business from one on a team that throws.

Everything here is a *tendency*, not an efficiency, and tendencies are choices.
They are therefore left unadjusted for opponent: a coach who passes on early
downs does so against good defenses and bad ones, and "opponent-adjusting" a
choice would subtract signal rather than noise. The defensive side of the ledger
is opponent-adjusted, and lives in `export_defense.py` where that is correct.

    uv run --project model python model/export_offense.py
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
from model.features.team_context import team_tendencies

#: Inside this yard line is the red zone.
RED_ZONE_YARDS = 20

#: Goal-line snaps, where the run/pass split is most lopsided and most decisive.
GOAL_LINE_YARDS = 5


def red_zone_tendency(store: FeatureStore, as_of: AsOf, seasons_back: int = 1) -> dict[str, dict]:
    """Run/pass split near the goal, per offence.

    Kept separate from the neutral-situation numbers because it is a different
    question. A team can be pass-first between the twenties and hand off every
    snap inside the five, and those two facts point at different players.
    """
    raw = store.as_of("pbp", as_of, seasons_back=seasons_back).pl()
    if raw.height == 0:
        return {}

    plays = raw.filter(
        pl.col("posteam").is_not_null()
        & pl.col("yardline_100").is_not_null()
        & (pl.col("play_type").is_in(["pass", "run"]))
        & (pl.col("yardline_100") <= RED_ZONE_YARDS)
    ).with_columns((pl.col("play_type") == "pass").cast(pl.Float64).alias("is_pass"))

    if plays.height == 0:
        return {}

    red = plays.group_by("posteam").agg(
        pl.len().alias("red_zone_plays"),
        pl.col("is_pass").mean().alias("red_zone_pass_rate"),
        pl.col("touchdown").cast(pl.Float64).fill_null(0.0).sum().alias("red_zone_tds"),
    )

    goal = (
        plays.filter(pl.col("yardline_100") <= GOAL_LINE_YARDS)
        .group_by("posteam")
        .agg(
            pl.len().alias("goal_line_plays"),
            pl.col("is_pass").mean().alias("goal_line_pass_rate"),
        )
    )

    merged = red.join(goal, on="posteam", how="left")

    return {
        canonical_team(row["posteam"]): {
            "redZonePlays": int(row["red_zone_plays"]),
            "redZonePassRate": round(float(row["red_zone_pass_rate"] or 0.0), 4),
            "redZoneTds": int(row["red_zone_tds"] or 0),
            "goalLinePlays": int(row["goal_line_plays"] or 0),
            "goalLinePassRate": (
                round(float(row["goal_line_pass_rate"]), 4)
                if row["goal_line_pass_rate"] is not None
                else None
            ),
        }
        for row in merged.to_dicts()
        if row["posteam"]
    }


def _percentiles(values: dict[str, float]) -> dict[str, float]:
    """Rank within the league, 0-1.

    Every number in this product is supposed to carry context (§67), and for a
    team tendency the context that matters is where it sits among the other
    thirty-one. "26.9 seconds per play" means nothing on its own; "4th fastest"
    is immediately actionable.
    """
    if not values:
        return {}
    ordered = sorted(values.values())
    span = max(1, len(ordered) - 1)
    return {
        team: round(sum(1 for v in ordered if v < value) / span, 4)
        for team, value in values.items()
    }


def build_artifact(season: int, week: int, lake: Path) -> dict:
    with FeatureStore(lake) as store:
        as_of = AsOf(season, week)
        tendencies = team_tendencies(store, as_of, seasons_back=1)
        red_zone = red_zone_tendency(store, as_of, seasons_back=1)

    if not tendencies:
        raise SystemExit(f"no play-by-play available for {season} week {week}")

    # One row per team: the most recent season observed.
    latest: dict[str, object] = {}
    for tendency in sorted(tendencies, key=lambda t: t.season):
        latest[canonical_team(tendency.team)] = tendency

    pace = {team: t.seconds_per_play for team, t in latest.items() if t.seconds_per_play > 0}
    plays = {team: t.plays_per_game for team, t in latest.items()}
    proe = {team: t.proe for team, t in latest.items()}

    # Faster is a lower number, so the percentile is inverted to keep "high is
    # more of the thing the label says".
    pace_pct = {team: round(1 - p, 4) for team, p in _percentiles(pace).items()}
    plays_pct = _percentiles(plays)
    proe_pct = _percentiles(proe)

    teams = {
        team: {
            "team": team,
            "season": tendency.season,
            "plays": tendency.plays,
            "playsPerGame": round(tendency.plays_per_game, 2),
            "playsPerGamePct": plays_pct.get(team),
            "secondsPerPlay": round(tendency.seconds_per_play, 2),
            "pacePct": pace_pct.get(team),
            "passRate": round(tendency.pass_rate, 4),
            "proe": round(tendency.proe, 4),
            "proePct": proe_pct.get(team),
            "neutralPassRate": round(tendency.neutral_pass_rate, 4),
            **red_zone.get(team, {}),
        }
        for team, tendency in latest.items()
    }

    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "season": season,
        "week": week,
        "teamCount": len(teams),
        "note": (
            "Tendencies are choices and are deliberately not opponent-adjusted: "
            "a coach who passes on early downs does so against every defense, and "
            "adjusting a choice would subtract signal. Defensive numbers, where "
            "opponent adjustment is correct, live in defense-scheme.json."
        ),
        "teams": teams,
    }


if __name__ == "__main__":
    default_season, default_week = current_week()
    season = int(sys.argv[1]) if len(sys.argv) > 1 else default_season
    week = int(sys.argv[2]) if len(sys.argv) > 2 else default_week

    artifact = build_artifact(season, week, default_lake())
    out = Path("model/artifacts/team-offense.json")
    out.write_text(json.dumps(artifact, separators=(",", ":"), sort_keys=True), encoding="utf-8")

    print(f"{out}: {artifact['teamCount']} offences")
    ranked = sorted(
        artifact["teams"].values(), key=lambda t: t.get("proe") or 0.0, reverse=True
    )
    print(f"  {'team':5s} {'plays/g':>8s} {'sec/play':>9s} {'PROE':>7s} {'neutral':>8s} {'RZ pass':>8s}")
    for team in [*ranked[:3], *ranked[-3:]]:
        rz = team.get("redZonePassRate")
        print(
            f"  {team['team']:5s} {team['playsPerGame']:8.1f} {team['secondsPerPlay']:9.1f} "
            f"{team['proe']:+7.3f} {team['neutralPassRate']:8.3f} "
            f"{(f'{rz:.3f}' if rz is not None else '—'):>8s}"
        )
