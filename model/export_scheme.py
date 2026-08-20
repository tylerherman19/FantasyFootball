"""Export defensive scheme profiles and the week's matchups as an artifact.

The projection artifact answers "how much will this player do". This one answers
"against what" — which is the question a manager actually asks when two backs
project within a point of each other.

Scheme comes from participation charting, which is published after a season
ends, so during the year a defense is described by its most recent completed
season. That is legal, because last season is public, and sound, because scheme
tendencies are among the stickiest things in football: a two-high coordinator is
still a two-high coordinator in September. Coordinator changes are the exception,
and the artifact carries the sample size so a stale profile is visible rather
than implied.

Rates are exported alongside their league percentile. "Blitzes 28% of dropbacks"
means nothing to most readers; "blitzes more than 90% of defenses" means
something immediately.

    uv run --project model python model/export_scheme.py 2026 1
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import polars as pl

from model.backtest.harness import default_lake
from model.features.scheme import defensive_profiles
from model.features.store import AsOf, FeatureStore
from model.features.team_context import defense_vs_position, team_tendencies

ARTIFACT_VERSION = "scheme-v2"

#: Rates that get a percentile. Time-to-throw is a duration, not a rate, but it
#: ranks the same way and reads the same way, so it is included.
RANKED_FIELDS = (
    "blitz_rate",
    "pressure_rate",
    "man_rate",
    "two_high_rate",
    "light_box_rate",
    "mean_time_to_throw",
)


def percentile_of(values: list[float], value: float) -> float:
    """Share of the league at or below `value`, 0-1."""
    if not values:
        return 0.5
    return sum(1 for other in values if other <= value) / len(values)


def week_matchups(store: FeatureStore, season: int, week: int) -> dict[str, dict[str, str]]:
    """Each team's opponent and venue for the given week."""
    games = store.raw("schedules").pl()
    subset = games.filter((pl.col("season") == season) & (pl.col("week") == week))

    out: dict[str, dict[str, str]] = {}
    for row in subset.iter_rows(named=True):
        home, away = str(row["home_team"]), str(row["away_team"])
        out[home] = {"opponent": away, "venue": "home"}
        out[away] = {"opponent": home, "venue": "away"}
    return out


#: Used only to rank defenses against each position. Each league still scores
#: its own way; this is a common yardstick, not a projection.
YARDSTICK_SCORING: dict[str, float] = {
    "passing_yards": 0.04, "passing_tds": 4.0, "passing_interceptions": -1.0,
    "rushing_yards": 0.1, "rushing_tds": 6.0,
    "receptions": 1.0, "receiving_yards": 0.1, "receiving_tds": 6.0,
}


def build(season: int, week: int, lake: Path) -> dict:
    with FeatureStore(lake) as store:
        as_of = AsOf(season, week)

        # seasons_back=2 so a team missing from the latest completed season
        # (charting gaps happen) still resolves to its prior profile.
        profiles = defensive_profiles(store, as_of, seasons_back=2)
        matchups = week_matchups(store, season, week)
        tendencies = team_tendencies(store, as_of, seasons_back=1)
        allowed = defense_vs_position(store, as_of, YARDSTICK_SCORING, seasons_back=1)

    if not profiles:
        raise SystemExit("no scheme profiles: is pbp_participation synced?")

    # One profile per team: the most recent season available for that team.
    latest: dict[str, object] = {}
    for profile in sorted(profiles, key=lambda p: p.season):
        latest[profile.team] = profile

    league = {
        field: [getattr(profile, field) for profile in latest.values()]
        for field in RANKED_FIELDS
    }

    defenses: dict[str, dict] = {}
    for team, profile in latest.items():
        record = asdict(profile)
        record["percentiles"] = {
            field: round(percentile_of(league[field], getattr(profile, field)), 3)
            for field in RANKED_FIELDS
        }
        defenses[team] = record

    # Offence identity: pace and pass-rate-over-expected, with percentiles so
    # "+0.04 PROE" becomes "passes more than 9 defenses in 10 would expect".
    latest_tendency = {}
    for tendency in sorted(tendencies, key=lambda t: t.season):
        latest_tendency[tendency.team] = tendency

    proe_values = [t.proe for t in latest_tendency.values()]
    pace_values = [t.plays_per_game for t in latest_tendency.values()]

    offences = {
        team: {
            "season": tendency.season,
            "plays_per_game": round(tendency.plays_per_game, 2),
            "seconds_per_play": round(tendency.seconds_per_play, 2),
            "pass_rate": round(tendency.pass_rate, 4),
            "proe": round(tendency.proe, 4),
            "neutral_pass_rate": round(tendency.neutral_pass_rate, 4),
            "percentiles": {
                "proe": round(percentile_of(proe_values, tendency.proe), 3),
                "plays_per_game": round(
                    percentile_of(pace_values, tendency.plays_per_game), 3
                ),
            },
        }
        for team, tendency in latest_tendency.items()
    }

    # What each defense concedes by position, schedule-adjusted. The percentile
    # is oriented so that higher always means "better for the offence".
    defense_positions: dict[str, dict[str, dict]] = {}
    if allowed.height > 0:
        for position in allowed["position"].unique().to_list():
            subset = allowed.filter(pl.col("position") == position)
            values = subset["adjusted"].to_list()
            for row in subset.to_dicts():
                defense_positions.setdefault(row["defense"], {})[position] = {
                    "raw": round(float(row["raw"]), 2),
                    "adjusted": round(float(row["adjusted"]), 2),
                    "softness": round(percentile_of(values, float(row["adjusted"])), 3),
                }

    return {
        "artifactVersion": ARTIFACT_VERSION,
        "offences": offences,
        "defenseVsPosition": defense_positions,
        "generatedAt": datetime.now(UTC).isoformat(),
        "season": season,
        "week": week,
        # Named explicitly: these tendencies describe a completed season, not
        # the one being predicted.
        "schemeSeason": max(profile.season for profile in latest.values()),
        "defenses": defenses,
        "matchups": matchups,
    }


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("usage: export_scheme.py <season> <week>")

    season, week = int(sys.argv[1]), int(sys.argv[2])
    artifact = build(season, week, default_lake())

    out = Path(__file__).parent / "artifacts" / f"scheme-{season}-{week:02d}.json"
    out.write_text(json.dumps(artifact, sort_keys=True), encoding="utf-8")

    print(
        f"wrote {out.name}: {len(artifact['defenses'])} defenses "
        f"(scheme from {artifact['schemeSeason']}), {len(artifact['matchups'])} matchups, "
        f"{len(artifact['offences'])} offence profiles, "
        f"{len(artifact['defenseVsPosition'])} defenses scored by position"
    )


if __name__ == "__main__":
    main()
