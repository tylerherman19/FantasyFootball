"""Export weekly projections as an artifact the TypeScript engine serves.

This is the seam the whole architecture rests on: Python owns modelling, and
never runs in the serving path. It writes a versioned JSON artifact; the app
reads it. That keeps the runtime cheap and the model reproducible.

Each player carries what the simulator needs, not just a point estimate:

- **mean and sd** — the forecast, plus how uncertain it is
- **gameId** — which NFL game they play in, so teammates and opponents correlate
- **gameLoading** — how much of their variance the game environment explains

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
from model.models import v1_usage

MODEL_VERSION = "v1-usage"

#: Share of a player's weekly variance explained by the game environment.
#: Passing games move together most; kickers barely care about script.
GAME_LOADING: dict[str, float] = {
    "QB": 0.45, "RB": 0.30, "WR": 0.40, "TE": 0.35,
    "K": 0.20, "DEF": 0.25, "DL": 0.15, "LB": 0.15, "DB": 0.15,
}

#: Full-PPR superflex defaults. The artifact is scored under one ruleset;
#: leagues with different rules get their own export keyed by scoring hash.
DEFAULT_RULES: dict[str, float] = {
    "pass_yd": 0.04, "pass_td": 4.0, "pass_int": -1.0,
    "rush_yd": 0.1, "rush_td": 6.0,
    "rec": 1.0, "rec_yd": 0.1, "rec_td": 6.0,
}


def load_crosswalk(path: Path) -> dict[str, dict]:
    """gsis_id -> identity, so nflverse projections can address Sleeper rosters."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for identity in payload["by_sleeper_id"].values():
        gsis = identity.get("gsis_id")
        if gsis:
            out[gsis] = identity
    return out


def game_index(store: FeatureStore, season: int, week: int) -> dict[str, str]:
    """team -> game id for one week, so correlated players find each other."""
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
        predictions = v1_usage.build(store, AsOf(season, week), rules=DEFAULT_RULES)
        games = game_index(store, season, week)

        # Current team per player, for the game assignment.
        rosters = store.as_of("weekly_rosters", AsOf(season, week), seasons_back=1).pl()
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

    for prediction in predictions:
        identity = crosswalk.get(prediction.player_id)
        if identity is None:
            unmapped += 1
            continue

        position = (identity.get("position") or "").upper()
        team = team_by_gsis.get(prediction.player_id) or identity.get("team") or ""

        players[identity["sleeper_id"]] = {
            "playerId": identity["sleeper_id"],
            "name": identity.get("name", ""),
            "position": position,
            "team": team,
            "mean": round(prediction.mean, 3),
            "sd": round(prediction.sd, 3),
            # A player with no scheduled game is on bye: no game id, not active.
            "gameId": games.get(team, ""),
            "gameLoading": GAME_LOADING.get(position, 0.3),
            "active": bool(games.get(team)),
        }

    return {
        "modelVersion": MODEL_VERSION,
        "season": season,
        "week": week,
        "generatedAt": datetime.now(UTC).isoformat(),
        "rules": DEFAULT_RULES,
        "playerCount": len(players),
        "unmappedCount": unmapped,
        "players": players,
    }


if __name__ == "__main__":
    season = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
    week = int(sys.argv[2]) if len(sys.argv) > 2 else 1

    artifact = build_artifact(
        season,
        week,
        default_lake(),
        Path("model/artifacts/crosswalk.json"),
    )

    out = Path(f"model/artifacts/projections-{season}-{week:02d}.json")
    out.write_text(json.dumps(artifact, separators=(",", ":"), sort_keys=True), encoding="utf-8")

    # Inactive means no scheduled game: a bye, or more often an unsigned player
    # still carrying a projection from last season's work.
    inactive = sum(1 for p in artifact["players"].values() if not p["active"])
    free_agents = sum(1 for p in artifact["players"].values() if p["team"] in ("", "FA"))
    print(
        f"{out}: {artifact['playerCount']} players, {artifact['unmappedCount']} unmapped, "
        f"{inactive} inactive ({free_agents} unsigned)"
    )

    top = sorted(artifact["players"].values(), key=lambda p: -p["mean"])[:8]
    for player in top:
        print(f"  {player['name'][:24]:24s} {player['position']:3s} {player['team']:4s} {player['mean']:6.2f} +/- {player['sd']:.1f}")
