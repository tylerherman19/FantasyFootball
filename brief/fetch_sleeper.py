#!/usr/bin/env python3
"""Fetch Sleeper fantasy football data for the weekly brief.

Stdlib only (urllib, json, os, time). Public Sleeper API, no auth.
Writes:
  data/sleeper.json   - user, week, leagues with rosters/matchups
  data/schedule.json  - hardcoded Week 1 2026 NFL slate
Caches:
  data/raw/players_nfl.json - full player map (~5-10MB), refreshed only if missing
"""

import json
import os
import time
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")
USERNAME = "tylerherman"
SEASON = "2026"

API = "https://api.sleeper.app/v1"
UA = {"User-Agent": "ffb-brief/1.0 (weekly fantasy brief)"}


def get(path):
    req = urllib.request.Request(API + path, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def player_detail(player_id, players_map):
    p = players_map.get(player_id, {}) if players_map else {}
    if not p:
        return {
            "player_id": player_id,
            "name": None,
            "position": None,
            "team": None,
            "injury_status": None,
        }
    team = p.get("team")
    name = p.get("full_name")
    if not name:
        # team defenses and some entries lack full_name
        fn, ln = p.get("first_name"), p.get("last_name")
        name = f"{fn} {ln}".strip() if (fn or ln) else None
    return {
        "player_id": player_id,
        "name": name,
        "position": p.get("position"),
        "team": team if team else None,
        "injury_status": p.get("injury_status"),
    }


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(RAW_DIR, exist_ok=True)

    # 1. user
    user = get(f"/user/{USERNAME}")
    user_id = user["user_id"]
    print(f"user_id={user_id}")

    # 2. NFL state
    state = get("/state/nfl")
    week = state.get("week")
    season = str(state.get("season"))
    print(f"nfl state: season={season} week={week} season_type={state.get('season_type')}")

    # 3. leagues
    leagues = get(f"/user/{user_id}/leagues/nfl/{SEASON}")
    print(f"found {len(leagues)} league(s)")

    # 4. players map (cached)
    players_path = os.path.join(RAW_DIR, "players_nfl.json")
    players_map = None
    if os.path.exists(players_path):
        print(f"using cached players: {players_path}")
        with open(players_path) as f:
            players_map = json.load(f)
    else:
        print("downloading players_nfl.json (large, ~5-10MB)...")
        players_map = get("/players/nfl")
        with open(players_path, "w") as f:
            json.dump(players_map, f)
        print(f"cached players: {players_path}")

    out_leagues = []
    for league in leagues:
        league_id = league["league_id"]
        name = league.get("name")
        print(f"league {league_id}: {name}")
        time.sleep(0.3)

        rosters = get(f"/league/{league_id}/rosters")
        time.sleep(0.3)
        users = get(f"/league/{league_id}/users")
        time.sleep(0.3)
        matchups = get(f"/league/{league_id}/matchups/{week}")

        owner_names = {u.get("user_id"): u.get("display_name") for u in users}

        matchup_pair = {}
        for m in matchups:
            matchup_pair[m.get("roster_id")] = m.get("matchup_id")
        by_matchup = {}
        for rid, mid in matchup_pair.items():
            by_matchup.setdefault(mid, []).append(rid)
        matchup_list = []
        for mid, rids in by_matchup.items():
            if len(rids) == 2:
                matchup_list.append(
                    {"roster_id": rids[0], "opponent_roster_id": rids[1]}
                )
            else:
                matchup_list.append(
                    {"roster_id": rids[0] if rids else None,
                     "opponent_roster_id": None}
                )

        out_rosters = []
        for r in rosters:
            owner_id = r.get("owner_id")
            starters = r.get("starters") or []
            players = r.get("players") or []
            out_rosters.append(
                {
                    "roster_id": r.get("roster_id"),
                    "owner_id": owner_id,
                    "owner_name": owner_names.get(owner_id),
                    "is_mine": owner_id == user_id,
                    "starters": [player_detail(pid, players_map) for pid in starters],
                    "players": [player_detail(pid, players_map) for pid in players],
                }
            )

        out_leagues.append(
            {
                "league_id": league_id,
                "name": name,
                "roster_positions": league.get("roster_positions"),
                "scoring_settings": league.get("scoring_settings"),
                "rosters": out_rosters,
                "matchups": matchup_list,
            }
        )

    sleeper_out = {"user_id": user_id, "week": week, "leagues": out_leagues}
    sleeper_path = os.path.join(DATA_DIR, "sleeper.json")
    with open(sleeper_path, "w") as f:
        json.dump(sleeper_out, f, indent=2)
    print(f"wrote {sleeper_path}")

    # Schedule: hardcoded Week 1 2026 slate (verified from newsletter)
    games = [
        ("NE", "SEA", "Wed 8:20pm"),   # Wed
        ("SF", "LAR", "Thu 8:20pm"),   # Thu
        ("TB", "CIN", "Sun"),
        ("NYJ", "TEN", "Sun"),
        ("BAL", "IND", "Sun"),
        ("ATL", "PIT", "Sun"),
        ("CHI", "CAR", "Sun"),
        ("CLE", "JAX", "Sun"),
        ("MIA", "LV", "Sun"),
        ("GB", "MIN", "Sun"),
        ("WAS", "PHI", "Sun"),
        ("ARI", "LAC", "Sun"),
        ("DAL", "NYG", "Sun night"),   # Sun night
        ("BUF", "HOU", "Sun"),
        ("NO", "DET", "Sun"),
        ("DEN", "KC", "Mon"),          # Mon
    ]
    sched_path = os.path.join(DATA_DIR, "schedule.json")
    with open(sched_path, "w") as f:
        json.dump(
            {
                "week": week,
                "games": [
                    {"away": a, "home": h, "label": lbl} for a, h, lbl in games
                ],
            },
            f,
            indent=2,
        )
    print(f"wrote {sched_path}")

    if week != 1:
        print("!!! WARNING: /v1/state/nfl says week != 1; schedule.json is Week 1 hardcoded !!!")


if __name__ == "__main__":
    main()
