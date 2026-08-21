"""Export each team's bye week.

Projections are exported one week at a time, and the season simulation reuses
the latest week for every week still to come. That is defensible for form — a
player's expected production next month is best estimated by what we think of
him now — but it is simply wrong about availability, because it carries one
week's schedule across the whole season.

The consequence is not subtle. Every team has a bye, so for one week in
fourteen the simulation starts a player who is not playing, and the manager is
told to start him too. In the other direction, a player whose bye happens to
fall in the exported week is treated as absent for the rest of the season.

The schedule is known in full in August, so this needs no model at all: a team
plays in every week except one, and the missing week is the bye.

    python model/export_byes.py 2026
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import polars as pl

from model.backtest.harness import default_lake


def bye_weeks(lake: Path, season: int) -> dict[str, int]:
    """The week each team does not appear on the schedule."""
    games = pl.scan_parquet(str(lake / "schedules")).filter(pl.col("season") == season).collect()
    if games.height == 0:
        raise SystemExit(f"no schedule rows for {season}")

    weeks = sorted({int(week) for week in games["week"].to_list()})
    teams = sorted(
        {str(team) for team in games["home_team"].to_list() + games["away_team"].to_list()}
    )

    playing: dict[str, set[int]] = {team: set() for team in teams}
    for row in games.iter_rows(named=True):
        week = int(row["week"])
        playing[str(row["home_team"])].add(week)
        playing[str(row["away_team"])].add(week)

    byes: dict[str, int] = {}
    for team in teams:
        # Only the regular season has byes; a team missing several weeks is a
        # data problem rather than a team with several byes, so take the first.
        missing = [week for week in weeks if week <= 18 and week not in playing[team]]
        if len(missing) == 1:
            byes[team] = missing[0]

    return byes


def main() -> None:
    season = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
    byes = bye_weeks(default_lake(), season)

    out = Path(__file__).parent / "artifacts" / f"byes-{season}.json"
    out.write_text(
        json.dumps(
            {"season": season, "generatedAt": datetime.now(UTC).isoformat(), "byes": byes},
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    print(f"wrote {out.name}: {len(byes)} teams with a bye")


if __name__ == "__main__":
    main()
