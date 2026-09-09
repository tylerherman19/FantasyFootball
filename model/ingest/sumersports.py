"""Pull SumerSports public team tables into the Parquet lake.

SumerSports (sumersports.com) server-renders its team stat tables with no auth —
an open gate in the same class as the nflverse mirror. Verified live 2026-09-09:

  /teams/offensive/?season=2025                     32 rows, EPA/Play family
  /teams/defensive/?season=2025                     same, plus rush-front rates
  /teams/offensive/formation-tendency/?season=2025  long table, team x formation
  /teams/offensive/personnel-tendency/?season=2025  long table, team x personnel
  (defensive equivalents exist for both tendency pages)

Coverage is 2022 onward; 2021 and earlier render with no data rows. Pages carry
a "Last Updated" stamp and refresh weekly in-season.

Availability discipline — this is the part that keeps the lake honest:

  * PRIOR-SEASON tables are serve-time safe. Last season is public information;
    feature builders read `season = as_of.season - 1` and nothing newer.
  * CURRENT-SEASON tables are season-to-date snapshots with no week column, so
    the feature store's as-of filter cannot keep the target week out of them.
    They are legal LIVE (the snapshot was fetched before the games being
    predicted) and illegal in backtests — we keep no historical weekly
    snapshots, so a 2025 table replayed over 2025 games would leak the future.
    The manifest note says this next to the data, and model/features/sumer.py
    enforces it.
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path

import httpx
import polars as pl

BASE = "https://sumersports.com/teams/{path}/?season={season}"
FIRST_SEASON = 2022  # verified: 2021 and earlier render empty

USER_AGENT = "ffe-model/0.0 (research mirror)"

# SumerSports prints full names ("1.Kansas City Chiefs"); the lake keys on
# nflverse-style abbreviations. Fail loudly on an unmapped name — a silent
# drop would leave a partial league that looks complete.
TEAM_NAME_TO_ABBR = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
    "Washington Football Team": "WAS",
}

# Header -> (column, kind). kinds: float, int, pct (stored as fraction).
TEAM_COLUMNS = {
    "EPA/Play": ("epa_play", "float"),
    "Total EPA": ("total_epa", "float"),
    "Success %": ("success_pct", "pct"),
    "EPA/Pass": ("epa_pass", "float"),
    "EPA/Rush": ("epa_rush", "float"),
    "Pass Yards": ("pass_yards", "int"),
    "Pass TD": ("pass_td", "int"),
    "Rush Yards": ("rush_yards", "int"),
    "Rush TD": ("rush_td", "int"),
    "ADoT": ("adot", "float"),
    "Scramble %": ("scramble_pct", "pct"),
    "Int %": ("int_pct", "pct"),
    "Man Run %": ("man_run_pct", "pct"),
    "Power Run %": ("power_run_pct", "pct"),
    "3-man Rush %": ("three_man_rush_pct", "pct"),
    "4-man Rush %": ("four_man_rush_pct", "pct"),
}

TENDENCY_COLUMNS = {
    "Formation Plays": ("grouping", "str"),
    "Personnel": ("grouping", "str"),
    "Plays": ("plays", "int"),
    "Pers. Plays": ("grouping_plays", "int"),
    "Rate": ("rate", "pct"),
    "EPA": ("total_epa", "float"),
    "EPA Rank": ("epa_rank", "int"),
    "EPA/Pass": ("epa_pass", "float"),
    "EPA/Rush": ("epa_rush", "float"),
}

#: (dataset name, page path, column map, kind label)
TABLES: tuple[tuple[str, str, dict, str], ...] = (
    ("sumer_team_offense", "offensive", TEAM_COLUMNS, "team"),
    ("sumer_team_defense", "defensive", TEAM_COLUMNS, "team"),
    ("sumer_formation_offense", "offensive/formation-tendency", TENDENCY_COLUMNS, "formation"),
    ("sumer_formation_defense", "defensive/formation-tendency", TENDENCY_COLUMNS, "formation"),
    ("sumer_personnel_offense", "offensive/personnel-tendency", TENDENCY_COLUMNS, "personnel"),
    ("sumer_personnel_defense", "defensive/personnel-tendency", TENDENCY_COLUMNS, "personnel"),
)

AVAILABILITY_NOTE = (
    "Prior-season table is serve-time safe (last season is public). Same-season "
    "snapshot is a season-to-date aggregate with no week column: legal live, "
    "NEVER in backtests (no historical weekly snapshots exist)."
)


class _TableParser(HTMLParser):
    """Extracts rows from the server-rendered <table> on each page."""

    def __init__(self) -> None:
        super().__init__()
        self.in_table = 0
        self.in_cell = False
        self.in_row = False
        self.cur_cell = ""
        self.cur_row: list[str] = []
        self.rows: list[list[str]] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "table":
            self.in_table += 1
        elif self.in_table:
            if tag == "tr":
                self.in_row = True
                self.cur_row = []
            elif tag in ("td", "th"):
                self.in_cell = True
                self.cur_cell = ""

    def handle_endtag(self, tag: str) -> None:
        if tag == "table":
            self.in_table -= 1
        elif self.in_table:
            if tag in ("td", "th") and self.in_cell:
                self.cur_row.append(self.cur_cell.strip())
                self.in_cell = False
            elif tag == "tr" and self.in_row:
                if self.cur_row:
                    self.rows.append(self.cur_row)
                self.in_row = False

    def handle_data(self, data: str) -> None:
        if self.in_cell:
            self.cur_cell += data


def _convert(raw: str, kind: str):
    raw = raw.strip()
    if raw == "":
        return None
    try:
        if kind == "pct":
            return round(float(raw.rstrip("%")) / 100.0, 6)
        if kind == "int":
            return int(raw.replace(",", ""))
        if kind == "float":
            return float(raw.replace(",", ""))
        return raw
    except ValueError:
        return None


def parse_table(html: str, columns: dict, expected_season: int) -> tuple[list[dict], str | None]:
    """Parse one page into row dicts. Raises ValueError on shape drift, season
    mismatch, or an unmapped team name - all feed-integrity failures, not data."""
    parser = _TableParser()
    parser.feed(html)
    if len(parser.rows) < 2:
        raise ValueError("no data rows on page (season not served?)")

    header = parser.rows[0]
    col_idx = {i: columns[h.strip()] for i, h in enumerate(header) if h.strip() in columns}
    if not col_idx:
        raise ValueError(f"no known columns in header: {header!r}")

    m = re.search(r"Last Updated[^0-9]*([0-9]{2}-[0-9]{2}-[0-9]{4})", html)
    last_updated = m.group(1) if m else None

    rows = []
    for row in parser.rows[1:]:
        if len(row) < 3:
            continue
        name = re.sub(r"^\d+\.", "", row[0]).strip()
        season_str = row[1].strip()
        if season_str and int(season_str) != int(expected_season):
            raise ValueError(f"page season mismatch: row says {season_str}, asked {expected_season}")
        abbr = TEAM_NAME_TO_ABBR.get(name)
        if abbr is None:
            raise ValueError(f"unmapped team name: {name!r}")
        record = {"season": int(expected_season), "team": abbr}
        for i, (field, kind) in col_idx.items():
            if i < len(row):
                record[field] = _convert(row[i], kind)
        rows.append(record)
    return rows, last_updated


def fetch_table(client: httpx.Client, path: str, season: int, columns: dict) -> tuple[pl.DataFrame | None, str | None]:
    url = BASE.format(path=path, season=int(season))
    resp = client.get(url, timeout=45)
    resp.raise_for_status()
    rows, stamp = parse_table(resp.text, columns, expected_season=season)
    if not rows:
        return None, stamp
    return pl.DataFrame(rows), stamp


def sync(out_root: Path, seasons: range, *, overwrite: bool = False, pause: float = 0.75) -> dict[str, int]:
    """Mirror the SumerSports tables to Parquet. Returns rows written per dataset.

    Completed seasons are static and skip when cached; the current season always
    refreshes. Current-season snapshots are live-inference material only - see
    the module docstring.
    """
    written: dict[str, int] = {}
    assets: list[dict[str, object]] = []
    fetched_at = datetime.now(UTC).isoformat()
    current_season = datetime.now(UTC).year if datetime.now(UTC).month >= 3 else datetime.now(UTC).year - 1

    with httpx.Client(headers={"user-agent": USER_AGENT}) as client:
        for name, path, columns, _kind in TABLES:
            target_dir = out_root / name
            target_dir.mkdir(parents=True, exist_ok=True)
            total = 0
            for season in seasons:
                label = str(season)
                out_path = target_dir / f"{label}.parquet"
                if out_path.exists() and not overwrite and season < current_season:
                    rows = pl.scan_parquet(out_path).select(pl.len()).collect().item()
                    total += rows
                    assets.append({"dataset": name, "season": season,
                                   "path": str(out_path.relative_to(out_root)),
                                   "rows": rows, "bytes": out_path.stat().st_size})
                    continue
                try:
                    frame, stamp = fetch_table(client, path, season, columns)
                except ValueError as e:
                    print(f"  {name}/{label}: skipped ({e})")
                    continue
                if frame is None:
                    continue
                frame = frame.with_columns([
                    pl.lit(fetched_at).alias("fetched_at"),
                    pl.lit(stamp).alias("site_last_updated"),
                ])
                frame.write_parquet(out_path, compression="zstd")
                total += frame.height
                assets.append({"dataset": name, "season": season,
                               "path": str(out_path.relative_to(out_root)),
                               "rows": frame.height, "bytes": out_path.stat().st_size})
                print(f"  {name}/{label}: {frame.height:,} rows, {frame.width} cols (site stamp {stamp})")
                time.sleep(pause)  # be polite; unofficial gate
            written[name] = total

    _write_manifest(out_root, assets, fetched_at)
    return written


def _write_manifest(out_root: Path, assets: list[dict[str, object]], fetched_at: str) -> None:
    """Provenance sidecar, same role as the nflverse manifest."""
    payload = {
        "generatedAt": fetched_at,
        "source": "sumersports.com public team tables (no auth)",
        "datasets": [
            {"name": name, "serveTimeEligible": True, "note": AVAILABILITY_NOTE}
            for name, _p, _c, _k in TABLES
        ],
        "assets": assets,
    }
    (out_root / "manifest.sumersports.json").write_text(json.dumps(payload, indent=2))


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "data/lake")
    end = int(sys.argv[2]) if len(sys.argv) > 2 else datetime.now(UTC).year
    print(f"syncing sumersports {FIRST_SEASON}-{end} -> {root}")
    counts = sync(root, range(FIRST_SEASON, end + 1))
    print("\nrows per dataset:")
    for name, n in counts.items():
        print(f"  {name}: {n:,}")
