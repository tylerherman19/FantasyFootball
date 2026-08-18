"""Export weekly projections as an artifact the TypeScript engine serves.

This is the seam the architecture rests on: Python owns modelling and never runs
in the serving path. It writes a versioned artifact; the app reads it.

Critically, the artifact contains **stat lines, not points.** Tyler's three
leagues use 42, 64 and 132 distinct scoring keys — one has full IDP, one has
distance-banded field goals and yardage-allowed tiers. Exporting points under any
single ruleset would silently hand two of the three leagues wrong numbers, so the
model projects what a player will *do* and each league scores it its own way.

    uv run --project model python model/export_projections.py 2026 1
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import polars as pl

from model.backtest.harness import default_lake
from model.features.store import AsOf, FeatureStore
from model.models import v1_positional, v1_usage

MODEL_VERSION = "v1-usage+positional"

#: Share of a player's weekly variance explained by the game environment.
GAME_LOADING: dict[str, float] = {
    "QB": 0.45, "RB": 0.30, "WR": 0.40, "TE": 0.35,
    "K": 0.20, "DEF": 0.25, "DL": 0.15, "LB": 0.15, "DB": 0.15,
}

#: nflverse uses granular defensive positions; fantasy platforms bucket them
#: into three. A league with a "DL" slot will not accept a player listed "DE",
#: so the mapping has to happen before the artifact is written.
FANTASY_POSITION: dict[str, str] = {
    "DE": "DL", "DT": "DL", "NT": "DL", "DL": "DL",
    "OLB": "LB", "ILB": "LB", "MLB": "LB", "LB": "LB",
    "CB": "DB", "S": "DB", "SAF": "DB", "FS": "DB", "SS": "DB", "DB": "DB",
}


#: Only used to derive a spread, never to score. Points come from each league.
SPREAD_RULES: dict[str, float] = {
    "pass_yd": 0.04, "pass_td": 4.0, "pass_int": -1.0,
    "rush_yd": 0.1, "rush_td": 6.0,
    "rec": 1.0, "rec_yd": 0.1, "rec_td": 6.0,
}


def load_crosswalk(path: Path) -> dict[str, dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for identity in payload["by_sleeper_id"].values():
        gsis = identity.get("gsis_id")
        if gsis:
            out[gsis] = identity
    return out


def game_index(store: FeatureStore, season: int, week: int) -> dict[str, str]:
    games = store.raw("schedules").pl()
    subset = games.filter((pl.col("season") == season) & (pl.col("week") == week))

    index: dict[str, str] = {}
    for row in subset.iter_rows(named=True):
        game_id = str(row.get("game_id") or f"{season}_{week:02d}_{row['away_team']}_{row['home_team']}")
        index[str(row["home_team"])] = game_id
        index[str(row["away_team"])] = game_id
    return index


def build_artifact(season: int, week: int, lake: Path, crosswalk_path: Path) -> dict:
    with FeatureStore(lake) as store:
        as_of = AsOf(season, week)

        skill_lines = v1_usage.project_stat_lines(store, as_of)
        kicker_lines = v1_positional.kicker_stat_lines(store, as_of)
        idp_lines = v1_positional.idp_stat_lines(store, as_of)
        defense_lines = v1_positional.team_defense_stat_lines(store, as_of)

        # Spread comes from a reference scoring system: the shape of a player's
        # week is a property of the player, and rescaling it per league would
        # imply we know how each ruleset changes variance, which we don't.
        spreads = {p.player_id: p.sd for p in v1_usage.build(store, as_of, SPREAD_RULES)}

        games = game_index(store, season, week)

        rosters = store.as_of("weekly_rosters", as_of, seasons_back=1).pl()
        team_by_gsis: dict[str, str] = {}
        if rosters.height > 0 and "gsis_id" in rosters.columns:
            latest = (
                rosters.drop_nulls("gsis_id")
                .sort(["season", "week"])
                .group_by("gsis_id")
                .agg(pl.col("team").last())
            )
            team_by_gsis = dict(zip(latest["gsis_id"].to_list(), latest["team"].to_list(), strict=True))

    crosswalk = load_crosswalk(crosswalk_path)
    players: dict[str, dict] = {}
    unmapped = 0

    def add(source_id: str, stats: dict[str, float], *, is_team_defense: bool = False) -> None:
        nonlocal unmapped

        if is_team_defense:
            sleeper_id, name, position, team = source_id, f"{source_id} defense", "DEF", source_id
        else:
            identity = crosswalk.get(source_id)
            if identity is None:
                unmapped += 1
                return
            sleeper_id = identity["sleeper_id"]
            name = identity.get("name", "")
            raw_position = (identity.get("position") or "").upper()
            position = FANTASY_POSITION.get(raw_position, raw_position)
            team = team_by_gsis.get(source_id) or identity.get("team") or ""

        players[sleeper_id] = {
            "playerId": sleeper_id,
            "name": name,
            "position": position,
            "team": team,
            # Stat line, not points. The league scores it.
            "stats": {k: round(v, 4) for k, v in stats.items()},
            "sd": round(spreads.get(source_id, 6.0), 3),
            "gameId": games.get(team, ""),
            "gameLoading": GAME_LOADING.get(position, 0.3),
            "active": bool(games.get(team)),
        }

    for source_id, stats in skill_lines.items():
        add(source_id, stats)
    for source_id, stats in kicker_lines.items():
        add(source_id, stats)
    for source_id, stats in idp_lines.items():
        add(source_id, stats)
    for team, stats in defense_lines.items():
        add(team, stats, is_team_defense=True)

    return {
        "modelVersion": MODEL_VERSION,
        "season": season,
        "week": week,
        "generatedAt": datetime.now(UTC).isoformat(),
        "playerCount": len(players),
        "unmappedCount": unmapped,
        "players": players,
    }


def current_week() -> tuple[int, int]:
    """Season and week to export, taken from the NFL itself.

    Hardcoding a week means the weekly job silently keeps publishing week 1 for
    the whole season. Preseason maps to week 1, since that is what the app shows
    until games count.
    """
    import httpx

    state = httpx.get("https://api.sleeper.app/v1/state/nfl", timeout=30.0).json()
    season = int(state["season"])
    week = int(state["week"]) if state.get("season_type") == "regular" else 1
    return season, max(1, week)


if __name__ == "__main__":
    default_season, default_week = current_week()
    season = int(sys.argv[1]) if len(sys.argv) > 1 else default_season
    week = int(sys.argv[2]) if len(sys.argv) > 2 else default_week

    artifact = build_artifact(season, week, default_lake(), Path("model/artifacts/crosswalk.json"))

    out = Path(f"model/artifacts/projections-{season}-{week:02d}.json")
    out.write_text(json.dumps(artifact, separators=(",", ":"), sort_keys=True), encoding="utf-8")

    by_position: dict[str, int] = {}
    for player in artifact["players"].values():
        by_position[player["position"]] = by_position.get(player["position"], 0) + 1

    print(f"{out}: {artifact['playerCount']} players, {artifact['unmappedCount']} unmapped")
    for position, count in sorted(by_position.items(), key=lambda kv: -kv[1]):
        print(f"  {position or '?':4s} {count:5d}")
