#!/usr/bin/env python3
"""Fetch SumerSports public team stats + player sitemap into brief/ data files.

Polite scraping: stdlib only, ~2s delay between live requests, raw responses
cached to data/raw/ and reused on reruns (resume). Never touches locked
(paywalled) fields -- rows keep only fields actually present and unlocked.
"""
import json
import os
import re
import time
import urllib.request
import xml.etree.ElementTree as ET

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

TEAM_PAGES = [
    ("offense", "https://sumersports.com/teams/offensive/"),
    ("defense", "https://sumersports.com/teams/defensive/"),
    ("off_formation", "https://sumersports.com/teams/offensive/formation-tendency/"),
    ("off_personnel", "https://sumersports.com/teams/offensive/personnel-tendency/"),
    ("def_formation", "https://sumersports.com/teams/defensive/formation-tendency/"),
    ("def_personnel", "https://sumersports.com/teams/defensive/personnel-tendency/"),
]

PLAYER_SITEMAPS = [
    "https://sumersports.com/players/sitemap/0.xml",
    "https://sumersports.com/players/sitemap/1.xml",
    "https://sumersports.com/players/sitemap/2.xml",
]


def fetch(url, cache_path, headers=None, delay=2.0):
    """Return response body as text; skip the download if cache exists."""
    if os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            return f.read()
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        f.write(body)
    time.sleep(delay)
    return body


def extract_json_array(text, marker):
    """Bracket-match a JSON array following `marker`, string-aware."""
    start = text.index(marker)
    i = start + len(marker)
    if text[i - 1] == "[":  # marker included the opening bracket; step back to it
        i -= 1
    depth = 0
    in_str = False
    esc = False
    for j in range(i, len(text)):
        c = text[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c in "[{":
                depth += 1
            elif c in "]}":
                depth -= 1
                if depth == 0:
                    return json.loads(text[i:j + 1])
    raise ValueError("no closing bracket for %r" % marker)


def clean_row(row):
    """Drop locked (paywalled) fields; keep only unlocked, present fields."""
    locked = set(row.get("lockedFields") or [])
    return {
        k: v for k, v in row.items()
        if k not in locked and k != "lockedFields" and v is not None
    }


def parse_team_page(body):
    try:
        rows = extract_json_array(body, '"teamData":[')
    except ValueError:
        return []
    out = []
    for row in rows:
        if isinstance(row, dict):
            out.append(clean_row(row))
    return out


def derive_name(slug):
    return slug.replace("-", " ").title()


def build_player_index():
    players = []
    for idx, url in enumerate(PLAYER_SITEMAPS):
        cache = os.path.join(RAW_DIR, "players_sitemap_%d.xml" % idx)
        body = fetch(url, cache)
        root = ET.fromstring(body)
        locs = root.findall(".//{http://www.sitemaps.org/schemas/sitemap/0.9}loc")
        for loc in locs:
            page_url = loc.text.strip()
            slug = page_url.rstrip("/").rsplit("/", 1)[-1]
            players.append({"name": derive_name(slug), "url": page_url})
    # de-dupe on url, keep order
    seen, uniq = set(), []
    for p in players:
        if p["url"] not in seen:
            seen.add(p["url"])
            uniq.append(p)
    return uniq


def main():
    os.makedirs(RAW_DIR, exist_ok=True)
    teams = {}
    notes = []
    for name, url in TEAM_PAGES:
        body = fetch(url, os.path.join(RAW_DIR, "sumer_%s.rsc" % name),
                     headers={"RSC": "1"})
        rows = parse_team_page(body)
        teams[name] = rows
        types = sorted({r.get("__typename") for r in rows})
        notes.append("%s: %d rows, types=%s" % (name, len(rows), types))
        if not rows:
            notes.append("  WARNING: %s yielded nothing parseable" % name)
    with open(os.path.join(DATA_DIR, "sumer_teams.json"), "w") as f:
        json.dump(teams, f, indent=1)

    index = build_player_index()
    with open(os.path.join(DATA_DIR, "player_index.json"), "w") as f:
        json.dump(index, f, indent=1)

    print("\n".join(notes))
    print("players indexed:", len(index))


if __name__ == "__main__":
    main()
