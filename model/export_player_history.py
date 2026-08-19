"""Export what players have actually done, not just what they are projected to do.

A projection is one number with no memory. It cannot tell you that a receiver
has finished three straight seasons within a point of the same average, or that
a back's last two years were a cliff, or — the thing this file exists for — that
a quarterback's production collapses specifically against defenses that keep two
safeties deep.

Three kinds of history, all from nflverse weekly stats:

  **Shape.** A season average hides the distribution that produced it. Two
  receivers at twelve a game are different assets if one ranges eight to sixteen
  and the other alternates three and twenty-five, and in a head-to-head league
  the second loses you weeks the first wins. So floor, median and ceiling are
  percentiles of real games, and booms and busts are counted rather than implied.

  **Trend.** Dynasty is a bet on the next three years, not the last one. Season
  over season is the crudest useful version of that, and it is still more than a
  projection carries.

  **Scheme splits.** The point of the exercise. Every game is joined to the
  defense faced and bucketed by that defense's shell — so "two-high hurts
  receivers" stops being a claim about football in general and becomes a
  measured split for one specific player. Some are far more shell-sensitive than
  others, and that is invisible in any season-long number.

Scored in PPR and in standard, so a half-PPR league can interpolate and nobody
is handed a number from the wrong ruleset. Per-game usage travels alongside,
because usage is what carries forward.

    python model/export_player_history.py 2023 2024 2025
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import sys
import urllib.request
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

RELEASES = "https://github.com/nflverse/nflverse-data/releases/download"
ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"

#: Positions a fantasy manager makes decisions about.
POSITIONS = ("QB", "RB", "WR", "TE")

#: Below this, a player's record is noise rather than a track record.
MIN_GAMES = 4

#: A defense counts as playing it high, or loading the box, past these shell
#: cutoffs. Chosen to leave a genuine middle rather than forcing all 32 into
#: one of two buckets.
TWO_HIGH = 0.3
SINGLE_HIGH = -0.3

#: What a good and a bad week look like, in PPR points. Deliberately position
#: agnostic: a manager's week is decided by the total, not by whether fifteen
#: was impressive for the position.
BOOM = 20.0
BUST = 8.0


def _rows(url: str, cache: Path) -> list[dict[str, str]]:
    if cache.exists():
        raw = cache.read_bytes()
    else:
        with urllib.request.urlopen(url) as response:  # noqa: S310 - fixed host
            raw = response.read()
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(raw)

    with gzip.open(io.BytesIO(raw), "rt", newline="") as handle:
        return list(csv.DictReader(handle))


def _f(row: dict[str, str], key: str) -> float:
    value = row.get(key, "")
    if value in ("", "NA", "NaN", "None"):
        return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def _percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = q * (len(ordered) - 1)
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def _shells() -> dict[str, float]:
    """Defense -> shell index, from the scheme artifact if it has been built."""
    path = ARTIFACT_DIR / "defense-scheme.json"
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {team: entry["shellIndex"] for team, entry in payload["teams"].items()}


def build(seasons: list[int]) -> dict:
    shells = _shells()

    games: dict[str, dict[int, list[dict]]] = defaultdict(lambda: defaultdict(list))
    identity: dict[str, dict[str, str]] = {}

    for season in seasons:
        rows = _rows(
            f"{RELEASES}/stats_player/stats_player_week_{season}.csv.gz",
            ARTIFACT_DIR / ".cache" / f"stats_player_week_{season}.csv.gz",
        )

        for row in rows:
            if row.get("season_type") != "REG":
                continue
            position = row.get("position", "")
            if position not in POSITIONS:
                continue

            player = row.get("player_id", "")
            if player == "":
                continue

            identity[player] = {
                "name": row.get("player_display_name", ""),
                "position": position,
                "team": row.get("team", ""),
            }

            games[player][season].append(
                {
                    "ppr": _f(row, "fantasy_points_ppr"),
                    "standard": _f(row, "fantasy_points"),
                    "targets": _f(row, "targets"),
                    "carries": _f(row, "carries"),
                    "receptions": _f(row, "receptions"),
                    "yards": _f(row, "receiving_yards") + _f(row, "rushing_yards"),
                    "tds": _f(row, "passing_tds") + _f(row, "rushing_tds") + _f(row, "receiving_tds"),
                    "opponent": row.get("opponent_team", ""),
                }
            )

    players: dict[str, dict] = {}

    for player, by_season in games.items():
        every = [game for season_games in by_season.values() for game in season_games]
        if len(every) < MIN_GAMES:
            continue

        points = [game["ppr"] for game in every]

        by_year: dict[str, dict] = {}
        for season, season_games in sorted(by_season.items()):
            if len(season_games) < 2:
                continue
            season_points = [game["ppr"] for game in season_games]
            by_year[str(season)] = {
                "g": len(season_games),
                "ppg": round(sum(season_points) / len(season_points), 2),
                "std": round(sum(g["standard"] for g in season_games) / len(season_games), 2),
                "tgt": round(sum(g["targets"] for g in season_games) / len(season_games), 2),
                "car": round(sum(g["carries"] for g in season_games) / len(season_games), 2),
                "yds": round(sum(g["yards"] for g in season_games) / len(season_games), 1),
                "td": round(sum(g["tds"] for g in season_games) / len(season_games), 2),
            }

        if not by_year:
            continue

        # The split this whole file exists for. A player only gets one if he has
        # actually faced enough of both kinds of defense for the comparison to
        # mean anything.
        high_games = [g["ppr"] for g in every if shells.get(g["opponent"], 0.0) >= TWO_HIGH]
        low_games = [g["ppr"] for g in every if shells.get(g["opponent"], 0.0) <= SINGLE_HIGH]

        split = None
        if len(high_games) >= 3 and len(low_games) >= 3:
            high_ppg = sum(high_games) / len(high_games)
            low_ppg = sum(low_games) / len(low_games)
            split = {
                "twoHighPpg": round(high_ppg, 2),
                "twoHighGames": len(high_games),
                "singleHighPpg": round(low_ppg, 2),
                "singleHighGames": len(low_games),
                # Positive means he does better against a soft shell.
                "gap": round(high_ppg - low_ppg, 2),
            }

        years = sorted(by_year)
        latest = by_year[years[-1]]
        prior = by_year[years[-2]] if len(years) > 1 else None

        mean = sum(points) / len(points)

        players[player] = {
            "name": identity[player]["name"],
            "position": identity[player]["position"],
            "team": identity[player]["team"],
            "games": len(every),
            "ppg": round(mean, 2),
            "floor": round(_percentile(points, 0.25), 2),
            "median": round(_percentile(points, 0.5), 2),
            "ceiling": round(_percentile(points, 0.75), 2),
            "best": round(max(points), 2),
            "boomRate": round(sum(1 for p in points if p >= BOOM) / len(points), 3),
            "bustRate": round(sum(1 for p in points if p < BUST) / len(points), 3),
            # Coefficient of variation: spread relative to level, so a 20-point
            # player and a 6-point player compare on reliability rather than size.
            "volatility": round(
                (sum((p - mean) ** 2 for p in points) / max(len(points) - 1, 1)) ** 0.5
                / max(mean, 0.1),
                3,
            ),
            "bySeason": by_year,
            "latestSeason": int(years[-1]),
            "trend": None if prior is None else round(latest["ppg"] - prior["ppg"], 2),
            "schemeSplit": split,
        }

    return {
        "modelVersion": "history-v1-weekly",
        "generatedAt": datetime.now(UTC).isoformat(),
        "seasons": seasons,
        "newestSeason": max(seasons),
        "playerCount": len(players),
        "basis": "PPR scoring; standard carried alongside so half-PPR interpolates",
        "shellCutoffs": {"twoHigh": TWO_HIGH, "singleHigh": SINGLE_HIGH},
        "players": players,
    }


def main() -> None:
    seasons = [int(a) for a in sys.argv[1:]] or [2023, 2024, 2025]
    payload = build(sorted(seasons))

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    path = ARTIFACT_DIR / "player-history.json"
    path.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")

    with_split = sum(1 for p in payload["players"].values() if p["schemeSplit"])
    print(
        f"wrote {path} — {payload['playerCount']} players from {payload['seasons']}, "
        f"{with_split} with a scheme split ({path.stat().st_size / 1024:.0f} KB)"
    )


if __name__ == "__main__":
    main()
