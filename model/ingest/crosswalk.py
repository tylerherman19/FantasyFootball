"""Player identity across platforms.

Nothing in this system works without this join. Sleeper calls Ja'Marr Chase
`7564`, Yahoo calls him `33420`, and nflverse — where every stat, snap count and
charting row lives — calls him `00-0036900`. A projection built on nflverse
history is worthless until it can be attached to the player sitting on a Sleeper
roster.

DynastyProcess publishes the crosswalk as open data and keeps it current through
rookie season, so we consume it rather than maintaining our own name-matching,
which is a notorious source of silent, hard-to-notice errors (two players named
Michael Thomas, suffixes, apostrophes, mid-career name changes).

Exports a compact artifact keyed by Sleeper id, committed to the repo so the
TypeScript engine can resolve identities without a database round trip.
"""

from __future__ import annotations

import io
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx
import polars as pl

SOURCE = "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv"

#: Positions we model. IDP and specialists are carried through so the IDP league
#: resolves too, even though projections for them come later.
KEEP_POSITIONS = {"QB", "RB", "WR", "TE", "K", "DEF", "DL", "LB", "DB", "CB", "S", "DE", "DT", "OLB", "ILB"}


@dataclass(frozen=True)
class PlayerIdentity:
    sleeper_id: str
    gsis_id: str | None
    yahoo_id: str | None
    espn_id: str | None
    name: str
    position: str | None
    team: str | None
    birthdate: str | None
    draft_year: int | None
    draft_round: int | None
    draft_overall: int | None


def _clean(value: object) -> str | None:
    """DynastyProcess writes missing values as the literal string 'NA'."""
    if value is None:
        return None
    text = str(value).strip()
    return None if text in {"", "NA", "nan", "None"} else text


def fetch() -> pl.DataFrame:
    response = httpx.get(SOURCE, follow_redirects=True, timeout=120.0)
    response.raise_for_status()
    return pl.read_csv(io.BytesIO(response.content), infer_schema_length=20_000, ignore_errors=True)


def build(frame: pl.DataFrame) -> list[PlayerIdentity]:
    """One row per Sleeper id. Players without one can't appear on a roster."""
    rows: dict[str, PlayerIdentity] = {}

    for record in frame.iter_rows(named=True):
        sleeper_id = _clean(record.get("sleeper_id"))
        if sleeper_id is None:
            continue

        position = _clean(record.get("position"))
        if position is not None and position.upper() not in KEEP_POSITIONS:
            continue

        def as_int(key: str) -> int | None:
            raw = _clean(record.get(key))
            try:
                return int(float(raw)) if raw is not None else None
            except ValueError:
                return None

        identity = PlayerIdentity(
            sleeper_id=sleeper_id,
            gsis_id=_clean(record.get("gsis_id")),
            yahoo_id=_clean(record.get("yahoo_id")),
            espn_id=_clean(record.get("espn_id")),
            name=_clean(record.get("name")) or "",
            position=position,
            team=_clean(record.get("team")),
            birthdate=_clean(record.get("birthdate")),
            draft_year=as_int("draft_year"),
            draft_round=as_int("draft_round"),
            draft_overall=as_int("draft_ovr"),
        )

        # The file carries one row per player per season; later seasons overwrite
        # earlier ones, leaving the most current team and age.
        rows[sleeper_id] = identity

    return list(rows.values())


#: Sleeper identifies a team defense by the team abbreviation itself, not a
#: player id. They are scoring entities with no gsis id and never appear in a
#: player crosswalk, so they are synthesized here rather than left unresolved.
NFL_TEAMS = (
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB",
    "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
    "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
)


def _normalize_name(name: str) -> str:
    """Loose key for fallback matching: lowercase, no punctuation or suffixes."""
    text = name.lower().replace(".", "").replace("'", "").replace("-", " ")
    for suffix in (" jr", " sr", " ii", " iii", " iv", " v"):
        if text.endswith(suffix):
            text = text[: -len(suffix)]
    return " ".join(text.split())


def team_defenses() -> list[PlayerIdentity]:
    return [
        PlayerIdentity(
            sleeper_id=team,
            gsis_id=f"DEF-{team}",
            yahoo_id=None,
            espn_id=None,
            name=f"{team} defense",
            position="DEF",
            team=team,
            birthdate=None,
            draft_year=None,
            draft_round=None,
            draft_overall=None,
        )
        for team in NFL_TEAMS
    ]


def backfill_from_nflverse(
    identities: list[PlayerIdentity],
    sleeper_players: dict[str, dict],
    nflverse_players: pl.DataFrame,
) -> list[PlayerIdentity]:
    """Resolve what DynastyProcess misses — kickers and current rookies.

    Matching on normalized name plus position is only safe as a *fallback*: it
    is applied to players that have no crosswalk row at all, and a match is
    accepted only when it is unique. Ambiguous names are left unresolved on
    purpose, because a wrong join is far worse than a missing one — it silently
    attributes another player's entire history.
    """
    known = {i.sleeper_id for i in identities}

    lookup: dict[tuple[str, str], list[str]] = {}
    for row in nflverse_players.iter_rows(named=True):
        gsis = _clean(row.get("gsis_id"))
        name = _clean(row.get("display_name"))
        position = _clean(row.get("position"))
        if gsis is None or name is None or position is None:
            continue
        lookup.setdefault((_normalize_name(name), position.upper()), []).append(gsis)

    added: list[PlayerIdentity] = []

    for sleeper_id, player in sleeper_players.items():
        if sleeper_id in known:
            continue
        name = player.get("full_name")
        position = player.get("position")
        if not name or not position:
            continue

        candidates = lookup.get((_normalize_name(name), position.upper()), [])
        if len(candidates) != 1:
            continue  # ambiguous or absent — leave it unresolved

        added.append(
            PlayerIdentity(
                sleeper_id=sleeper_id,
                gsis_id=candidates[0],
                yahoo_id=None,
                espn_id=None,
                name=name,
                position=position.upper(),
                team=player.get("team"),
                birthdate=player.get("birth_date"),
                draft_year=None,
                draft_round=None,
                draft_overall=None,
            )
        )

    return identities + added


def export(identities: list[PlayerIdentity], out_path: Path) -> dict[str, int]:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "source": SOURCE,
        "count": len(identities),
        "by_sleeper_id": {i.sleeper_id: asdict(i) for i in identities},
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")

    return {
        "total": len(identities),
        "with_gsis": sum(1 for i in identities if i.gsis_id),
        "with_yahoo": sum(1 for i in identities if i.yahoo_id),
    }


if __name__ == "__main__":
    import sys

    target = Path(sys.argv[1] if len(sys.argv) > 1 else "model/artifacts/crosswalk.json")
    lake = Path("data/lake")

    identities = build(fetch()) + team_defenses()

    # Fallback pass for kickers and current rookies, which DynastyProcess omits.
    sleeper_players = httpx.get("https://api.sleeper.app/v1/players/nfl", timeout=180.0).json()
    nflverse = pl.read_parquet(lake / "players" / "all.parquet")
    identities = backfill_from_nflverse(identities, sleeper_players, nflverse)

    counts = export(identities, target)

    print(f"crosswalk -> {target}")
    for key, value in counts.items():
        share = value / counts["total"] if counts["total"] else 0
        print(f"  {key:12s} {value:>7,}  {share:6.1%}")
