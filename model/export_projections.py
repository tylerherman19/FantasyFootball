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
from model.export_byes import bye_weeks
from model.features.store import AsOf, FeatureStore
from model.models import rookie_prior, v1_positional, v1_usage

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


#: Team abbreviations, reconciled to the schedule's spelling.
#:
#: Three sources disagree, and the disagreement is silent. nflverse schedules say
#: `ARI`; nflverse *rosters* say `AZ`; DynastyProcess says `GBP`, `KAN`, `NOR`,
#: `LVR`. Nothing errors when they fail to match — a lookup just returns nothing,
#: so a player quietly ends up with no game, no bye and no opponent. That is how
#: 367 players came to have a null bye week while every individual source looked
#: fine on its own.
#:
#: The schedule wins, because it is what game ids and byes are keyed by.
#: Relocations map to the current franchise so historical rows resolve too.
TEAM_ALIASES: dict[str, str] = {
    "AZ": "ARI", "ARZ": "ARI",
    "BLT": "BAL",
    "CLV": "CLE",
    "GBP": "GB", "GNB": "GB",
    "HST": "HOU",
    "JAC": "JAX",
    "KAN": "KC",
    "LAR": "LA", "STL": "LA", "RAM": "LA",
    "SD": "LAC", "SDG": "LAC",
    "OAK": "LV", "LVR": "LV", "RAI": "LV",
    "NOR": "NO",
    "NWE": "NE",
    "SFO": "SF",
    "TAM": "TB",
    "WSH": "WAS", "WFT": "WAS",
}


def canonical_team(team: str | None) -> str:
    """One spelling for one franchise, in the schedule's code space."""
    if not team:
        return ""
    code = str(team).strip().upper()
    return TEAM_ALIASES.get(code, code)


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
        index[canonical_team(row["home_team"])] = game_id
        index[canonical_team(row["away_team"])] = game_id
    return index


def build_artifact(season: int, week: int, lake: Path, crosswalk_path: Path) -> dict:
    with FeatureStore(lake) as store:
        as_of = AsOf(season, week)

        skill_lines = v1_usage.project_stat_lines(store, as_of)
        kicker_lines = v1_positional.kicker_stat_lines(store, as_of)
        idp_lines = v1_positional.idp_stat_lines(store, as_of)
        defense_lines = v1_positional.team_defense_stat_lines(store, as_of)

        # Rookies, who v1 cannot see at all: it rebuilds a line from a player's
        # own history, and a player with no history forms no group, so no row is
        # emitted. Anyone v1 did cover is excluded — real observations beat a
        # draft-slot prior the moment they exist.
        rookie_lines, rookie_spreads, rookies = rookie_prior.project_rookie_stat_lines(
            store, as_of, exclude=set(skill_lines)
        )

        # Spread comes from a reference scoring system: the shape of a player's
        # week is a property of the player, and rescaling it per league would
        # imply we know how each ruleset changes variance, which we don't.
        spreads = {p.player_id: p.sd for p in v1_usage.build(store, as_of, SPREAD_RULES)}
        # Measured against rookie seasons specifically, and wider than the
        # veteran spread because a rookie's role is the least settled thing on
        # any roster.
        spreads.update(rookie_spreads)

        games = game_index(store, season, week)

        # Read forward-looking, not as-of. A roster is published before the week
        # it describes, so the completed-weeks filter would discard the entire
        # current season in week 1 and hand every player his *last* season's
        # team — silently, and wrongly for everyone who moved in the offseason.
        rosters = rookie_prior.current_rosters(store, as_of)
        team_by_gsis: dict[str, str] = {}
        if rosters.height > 0 and "gsis_id" in rosters.columns:
            latest = (
                rosters.drop_nulls("gsis_id")
                .sort(["season", "week"])
                .group_by("gsis_id")
                .agg(pl.col("team").last())
            )
            team_by_gsis = dict(zip(latest["gsis_id"].to_list(), latest["team"].to_list(), strict=True))

    # Byes come from the full season schedule, not from the exported week.
    #
    # `active` used to mean "this team has a game in week N", which the app then
    # reused as an availability flag for every remaining week. Both directions of
    # that are wrong: a player whose bye fell in the exported week was written
    # off for the rest of the season, and everyone else was simulated as playing
    # all fourteen — so for one week in fourteen the lineup page recommended
    # starting a man who was not playing. The schedule is fully known in August,
    # so this needs no model: a team plays every week but one.
    byes = {canonical_team(team): week for team, week in bye_weeks(lake, season).items()}

    crosswalk = load_crosswalk(crosswalk_path)
    players: dict[str, dict] = {}
    unmapped = 0

    def add(
        source_id: str,
        stats: dict[str, float],
        *,
        is_team_defense: bool = False,
        is_rookie: bool = False,
    ) -> None:
        nonlocal unmapped

        if is_team_defense:
            team = canonical_team(source_id)
            sleeper_id, name, position = source_id, f"{source_id} defense", "DEF"
        else:
            identity = crosswalk.get(source_id)
            if identity is None:
                unmapped += 1
                return
            sleeper_id = identity["sleeper_id"]
            name = identity.get("name", "")
            raw_position = (identity.get("position") or "").upper()
            position = FANTASY_POSITION.get(raw_position, raw_position)
            team = canonical_team(team_by_gsis.get(source_id) or identity.get("team"))

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
            # The week this player's team does not play, for the whole season.
            # `null` when the team is unknown or the schedule is incomplete —
            # which the app must read as "no bye known", never as "bye in week 0".
            "byeWeek": byes.get(team),
            # Now means what it says: on an NFL roster. Whether he plays in any
            # given week is `byeWeek` plus the injury designation applied at
            # serve time, both of which vary by week and neither of which
            # belongs in a flag baked once per artifact.
            "active": bool(team),
            # Carried so the UI can say where the number came from. A rookie's
            # line is a draft-capital prior, not an observed history, and a
            # product that shows the two identically is lying by omission.
            "basis": "rookie-prior" if is_rookie else "history",
        }

    for source_id, stats in skill_lines.items():
        add(source_id, stats)
    for source_id, stats in rookie_lines.items():
        add(source_id, stats, is_rookie=True)
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
        "rookieCount": sum(1 for p in players.values() if p.get("basis") == "rookie-prior"),
        "byeTeams": len(byes),
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

    print(
        f"{out}: {artifact['playerCount']} players "
        f"({artifact['rookieCount']} rookie priors), "
        f"{artifact['unmappedCount']} unmapped, "
        f"{artifact['byeTeams']} byes"
    )
    for position, count in sorted(by_position.items(), key=lambda kv: -kv[1]):
        print(f"  {position or '?':4s} {count:5d}")
