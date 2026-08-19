"""Export what each defense actually does to the offenses it faces.

The scheme module in `model/features/scheme.py` characterises defenses from
participation charting — coverage shells, box counts, pass rushers. That data
is no longer published: nflverse retired the `pbp_participation` release, and
it was always a prior-season-only feature because the charting arrived after
the season ended.

So this takes the other road, and it is arguably the better one. Rather than
reading a defense's *intent* off a charting label, it measures the *consequence*
straight from play-by-play — which is public, updated weekly during the season,
and is what a fantasy manager actually cares about anyway. A defense that lines
up in two-high does not matter; a defense that in fact allows nothing deep does.

The signature of a two-high, light-box defense is visible without ever seeing a
safety:

  - short average depth of target, because the deep shot is not there
  - a low share of attempts thrown 20+ yards downfield
  - a high share of receiving yards coming after the catch, because the throws
    that are available are underneath
  - opposing runs that work, because the box is a man light

Single-high is the mirror image: the deep ball is live, the run is not. Neither
is better — they are different bets, and they move different fantasy positions
in opposite directions, which is the whole point of the page this feeds.

Everything is opponent-adjusted. A defense that happened to face four terrible
offenses is not good, and the raw rates cannot tell the difference; an additive
offense/defense decomposition can.

Deliberately stdlib-only. The rest of the model pipeline needs polars, duckdb
and a parquet lake; this needs a CSV and arithmetic, so it runs in CI, on a
laptop, or anywhere else without a data lake being built first.

    python model/export_defense.py 2024 2025
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

#: Newer seasons describe the present better; older ones stop it being noise.
#: A defense turns over ~20% of its snaps and often its coordinator, so the
#: half-life here is deliberately short.
SEASON_WEIGHTS = {0: 1.0, 1: 0.5, 2: 0.25}

#: A throw travelling this far past the line is a shot, by the usual convention.
DEEP_AIR_YARDS = 20.0

#: Gains that break a drive open. Separate thresholds because a 20-yard run and
#: a 20-yard catch are not equally rare.
EXPLOSIVE_PASS = 20.0
EXPLOSIVE_RUSH = 10.0

ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"


def _fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as response:  # noqa: S310 - fixed host
        return response.read()


def _rows(url: str, cache: Path) -> list[dict[str, str]]:
    """Read a gzipped nflverse CSV, mirroring it next to the artifacts."""
    if cache.exists():
        raw = cache.read_bytes()
    else:
        raw = _fetch(url)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(raw)

    with gzip.open(io.BytesIO(raw), "rt", newline="") as handle:
        return list(csv.DictReader(handle))


def _f(row: dict[str, str], key: str) -> float | None:
    """nflverse writes NA as an empty string or the literal NA."""
    value = row.get(key, "")
    if value in ("", "NA", "NaN", "None"):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _positions() -> dict[str, str]:
    """gsis id -> fantasy position group, for splitting targets by who caught them."""
    rows = _rows(f"{RELEASES}/players/players.csv.gz", ARTIFACT_DIR / ".cache" / "players.csv.gz")

    out: dict[str, str] = {}
    for row in rows:
        gsis = row.get("gsis_id", "")
        if gsis == "":
            continue
        group = row.get("position_group", "") or row.get("position", "")
        if group in ("WR", "TE", "RB", "QB"):
            out[gsis] = group
    return out


class Tally:
    """Running totals for one defense in one season."""

    __slots__ = (
        "dropbacks", "attempts", "completions", "air_yards", "pass_yards", "yac",
        "sacks", "qb_hits", "interceptions", "deep_attempts", "explosive_passes",
        "pass_epa", "rushes", "rush_yards", "rush_epa", "explosive_rushes",
        "targets_by_group", "games",
    )

    def __init__(self) -> None:
        self.dropbacks = 0.0
        self.attempts = 0.0
        self.completions = 0.0
        self.air_yards = 0.0
        self.pass_yards = 0.0
        self.yac = 0.0
        self.sacks = 0.0
        self.qb_hits = 0.0
        self.interceptions = 0.0
        self.deep_attempts = 0.0
        self.explosive_passes = 0.0
        self.pass_epa = 0.0
        self.rushes = 0.0
        self.rush_yards = 0.0
        self.rush_epa = 0.0
        self.explosive_rushes = 0.0
        self.targets_by_group: dict[str, float] = defaultdict(float)
        self.games: set[str] = set()


def _collect(seasons: list[int], positions: dict[str, str]):
    """Per-defense tallies, plus the offense-vs-defense pairs used for adjustment."""
    tallies: dict[tuple[str, int], Tally] = defaultdict(Tally)
    # (offense, defense, season) -> per-play values, for the additive decomposition.
    pairs: list[tuple[str, str, int, str, float]] = []

    for season in seasons:
        rows = _rows(
            f"{RELEASES}/pbp/play_by_play_{season}.csv.gz",
            ARTIFACT_DIR / ".cache" / f"play_by_play_{season}.csv.gz",
        )

        for row in rows:
            if row.get("season_type") != "REG":
                continue

            defense = row.get("defteam", "")
            offense = row.get("posteam", "")
            if defense == "" or offense == "":
                continue

            play = row.get("play_type", "")
            tally = tallies[(defense, season)]
            game = row.get("game_id", "")
            if game:
                tally.games.add(game)

            epa = _f(row, "epa")

            if play == "pass":
                sack = (_f(row, "sack") or 0.0) >= 1
                tally.dropbacks += 1
                if sack:
                    tally.sacks += 1
                else:
                    tally.attempts += 1

                    air = _f(row, "air_yards")
                    if air is not None:
                        tally.air_yards += air
                        if air >= DEEP_AIR_YARDS:
                            tally.deep_attempts += 1
                        pairs.append((offense, defense, season, "adot", air))

                    if (_f(row, "complete_pass") or 0.0) >= 1:
                        tally.completions += 1
                        gained = _f(row, "yards_gained") or 0.0
                        tally.pass_yards += gained
                        tally.yac += _f(row, "yards_after_catch") or 0.0
                        if gained >= EXPLOSIVE_PASS:
                            tally.explosive_passes += 1

                    if (_f(row, "interception") or 0.0) >= 1:
                        tally.interceptions += 1

                    receiver = row.get("receiver_player_id", "")
                    group = positions.get(receiver)
                    if group in ("WR", "TE", "RB"):
                        tally.targets_by_group[group] += 1

                if (_f(row, "qb_hit") or 0.0) >= 1:
                    tally.qb_hits += 1
                if epa is not None:
                    tally.pass_epa += epa
                    pairs.append((offense, defense, season, "pass_epa", epa))

            elif play == "run":
                tally.rushes += 1
                gained = _f(row, "yards_gained") or 0.0
                tally.rush_yards += gained
                if gained >= EXPLOSIVE_RUSH:
                    tally.explosive_rushes += 1
                if epa is not None:
                    tally.rush_epa += epa
                    pairs.append((offense, defense, season, "rush_epa", epa))

    return tallies, pairs


def _adjust(pairs, metric: str, shrink: float = 40.0) -> dict[str, float]:
    """Split a per-play average into an offense effect and a defense effect.

        value = mean + offense_effect + defense_effect

    Fitted by alternating least squares, which for a two-way additive model is
    just "average the residuals" and converges in a handful of passes. The
    shrink term pulls a unit with few plays toward league average, so a defense
    that faced two hundred dropbacks is not ranked as confidently as one that
    faced six hundred.

    This is what separates a genuinely stingy defense from one that drew a soft
    schedule — without it, every rate here is partly a statement about the
    offenses that happened to be on the other side.
    """
    values = [(o, d, v) for (o, d, _s, m, v) in pairs if m == metric]
    if not values:
        return {}

    mean = sum(v for _o, _d, v in values) / len(values)

    offense: dict[str, float] = defaultdict(float)
    defense: dict[str, float] = defaultdict(float)

    for _ in range(25):
        off_sum: dict[str, float] = defaultdict(float)
        off_n: dict[str, int] = defaultdict(int)
        for o, d, v in values:
            off_sum[o] += v - mean - defense[d]
            off_n[o] += 1
        for team, total in off_sum.items():
            offense[team] = total / (off_n[team] + shrink)

        def_sum: dict[str, float] = defaultdict(float)
        def_n: dict[str, int] = defaultdict(int)
        for o, d, v in values:
            def_sum[d] += v - mean - offense[o]
            def_n[d] += 1
        for team, total in def_sum.items():
            defense[team] = total / (def_n[team] + shrink)

    return dict(defense)


def _zscores(values: dict[str, float]) -> dict[str, float]:
    if not values:
        return {}
    mean = sum(values.values()) / len(values)
    variance = sum((v - mean) ** 2 for v in values.values()) / max(len(values) - 1, 1)
    sd = variance ** 0.5 or 1.0
    return {team: (value - mean) / sd for team, value in values.items()}


def build(seasons: list[int]) -> dict:
    positions = _positions()
    tallies, pairs = _collect(seasons, positions)

    newest = max(seasons)
    weight_of = {s: SEASON_WEIGHTS.get(newest - s, 0.1) for s in seasons}

    # Blend seasons into one profile per defense, weighting recent play higher.
    blended: dict[str, Tally] = defaultdict(Tally)
    for (team, season), tally in tallies.items():
        weight = weight_of[season]
        target = blended[team]
        for field in Tally.__slots__:
            if field in ("targets_by_group", "games"):
                continue
            setattr(target, field, getattr(target, field) + getattr(tally, field) * weight)
        for group, count in tally.targets_by_group.items():
            target.targets_by_group[group] += count * weight
        target.games |= tally.games

    adjusted_adot = _adjust(pairs, "adot")
    adjusted_pass = _adjust(pairs, "pass_epa")
    adjusted_rush = _adjust(pairs, "rush_epa")

    teams: dict[str, dict] = {}
    for team, tally in blended.items():
        if tally.dropbacks < 50:
            continue

        attempts = max(tally.attempts, 1.0)
        completions = max(tally.completions, 1.0)
        rushes = max(tally.rushes, 1.0)
        targets = sum(tally.targets_by_group.values()) or 1.0

        teams[team] = {
            "team": team,
            "games": len(tally.games),
            "dropbacks": round(tally.dropbacks, 1),
            "adotAllowed": round(tally.air_yards / attempts, 3),
            "deepRateAllowed": round(tally.deep_attempts / attempts, 4),
            "completionRateAllowed": round(tally.completions / attempts, 4),
            "ypaAllowed": round(tally.pass_yards / attempts, 3),
            "yacShareAllowed": round(tally.yac / max(tally.pass_yards, 1.0), 4),
            "explosivePassRateAllowed": round(tally.explosive_passes / completions, 4),
            "sackRate": round(tally.sacks / max(tally.dropbacks, 1.0), 4),
            "qbHitRate": round(tally.qb_hits / max(tally.dropbacks, 1.0), 4),
            "intRate": round(tally.interceptions / attempts, 4),
            "ypcAllowed": round(tally.rush_yards / rushes, 3),
            "explosiveRushRateAllowed": round(tally.explosive_rushes / rushes, 4),
            "targetShareAllowed": {
                group: round(tally.targets_by_group.get(group, 0.0) / targets, 4)
                for group in ("WR", "TE", "RB")
            },
            # Opponent-adjusted, in the natural units of each metric. Negative
            # is good for the defense on the EPA measures.
            "adotAdjusted": round(adjusted_adot.get(team, 0.0), 4),
            "passEpaAdjusted": round(adjusted_pass.get(team, 0.0), 4),
            "rushEpaAdjusted": round(adjusted_rush.get(team, 0.0), 4),
        }

    # The shell index: how far toward "keep it in front of us" a defense sits.
    #
    # Four independent signatures of the same posture, averaged as z-scores so
    # no single one dominates: nothing thrown deep, nothing thrown far, yards
    # earned after the catch rather than in the air, and a run game that works.
    deep = _zscores({t: -v["deepRateAllowed"] for t, v in teams.items()})
    adot = _zscores({t: -v["adotAllowed"] for t, v in teams.items()})
    yac = _zscores({t: v["yacShareAllowed"] for t, v in teams.items()})
    rush = _zscores({t: v["rushEpaAdjusted"] for t, v in teams.items()})

    pressure = _zscores({t: v["sackRate"] + v["qbHitRate"] for t, v in teams.items()})

    for team, entry in teams.items():
        entry["shellIndex"] = round(
            (deep.get(team, 0) + adot.get(team, 0) + yac.get(team, 0) + rush.get(team, 0)) / 4, 3
        )
        entry["pressureIndex"] = round(pressure.get(team, 0), 3)

    def average(key: str) -> float:
        return round(sum(v[key] for v in teams.values()) / max(len(teams), 1), 4)

    return {
        "modelVersion": "defense-v1-pbp",
        "generatedAt": datetime.now(UTC).isoformat(),
        "seasons": seasons,
        "teamCount": len(teams),
        "leagueAverage": {
            key: average(key)
            for key in (
                "adotAllowed", "deepRateAllowed", "completionRateAllowed", "ypaAllowed",
                "yacShareAllowed", "explosivePassRateAllowed", "sackRate", "qbHitRate",
                "intRate", "ypcAllowed", "explosiveRushRateAllowed",
            )
        },
        "teams": teams,
    }


def main() -> None:
    seasons = [int(a) for a in sys.argv[1:]] or [2024, 2025]
    payload = build(sorted(seasons))

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    path = ARTIFACT_DIR / "defense-scheme.json"
    path.write_text(json.dumps(payload, indent=1, sort_keys=True), encoding="utf-8")

    print(f"wrote {path} — {payload['teamCount']} defenses from {payload['seasons']}")


if __name__ == "__main__":
    main()
