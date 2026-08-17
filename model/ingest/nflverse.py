"""Pull nflverse releases into a local Parquet lake.

nflverse publishes every dataset as gzipped CSV on GitHub releases, one asset
per season. We mirror what we need to Parquet once, then DuckDB queries it
directly — no database server, no re-downloading 25 seasons to answer a
question.

Training window is 2016+ (the Next Gen Stats era). Play-by-play goes back to
1999, but the game changed enough that older seasons hurt more than they help.
"""

from __future__ import annotations

import gzip
import io
from dataclasses import dataclass
from pathlib import Path

import httpx
import polars as pl

RELEASES = "https://github.com/nflverse/nflverse-data/releases/download"

# First season with Next Gen Stats. See module docstring.
FIRST_SEASON = 2016


@dataclass(frozen=True)
class Dataset:
    """One nflverse release, and how its assets are named."""

    name: str
    release: str
    #: Asset filename pattern. `{season}` is substituted when per_season is True.
    asset: str
    per_season: bool = True
    #: Availability caveats worth recording next to the data itself.
    note: str = ""


DATASETS: tuple[Dataset, ...] = (
    Dataset("pbp", "pbp", "play_by_play_{season}.csv.gz"),
    Dataset("player_stats", "stats_player", "stats_player_week_{season}.csv.gz"),
    Dataset("team_stats", "stats_team", "stats_team_week_{season}.csv.gz"),
    Dataset("snap_counts", "snap_counts", "snap_counts_{season}.csv.gz"),
    Dataset("depth_charts", "depth_charts", "depth_charts_{season}.csv.gz"),
    Dataset("injuries", "injuries", "injuries_{season}.csv.gz"),
    Dataset("weekly_rosters", "weekly_rosters", "roster_weekly_{season}.csv.gz"),
    Dataset("ngs_passing", "nextgen_stats", "ngs_{season}_passing.csv.gz"),
    Dataset("ngs_receiving", "nextgen_stats", "ngs_{season}_receiving.csv.gz"),
    Dataset("ngs_rushing", "nextgen_stats", "ngs_{season}_rushing.csv.gz"),
    Dataset(
        "ftn_charting",
        "ftn_charting",
        "ftn_charting_{season}.csv.gz",
        note="TRAIN-TIME ONLY: published after the season ends. Never an in-season input.",
    ),
    Dataset(
        "pbp_participation",
        "pbp_participation",
        "pbp_participation_{season}.csv.gz",
        note="TRAIN-TIME ONLY: post-season release; coverage stops after 2023.",
    ),
    Dataset("schedules", "schedules", "games.csv.gz", per_season=False),
    Dataset("players", "players", "players.csv.gz", per_season=False),
    Dataset("combine", "combine", "combine.csv.gz", per_season=False),
    Dataset("draft_picks", "draft_picks", "draft_picks.csv.gz", per_season=False),
)

#: Datasets that must never be read at inference time. Enforced by the feature
#: store; listed here so the reason travels with the data.
TRAIN_TIME_ONLY = frozenset(d.name for d in DATASETS if d.note.startswith("TRAIN-TIME ONLY"))


def _url(dataset: Dataset, season: int | None) -> str:
    asset = dataset.asset.format(season=season) if season is not None else dataset.asset
    return f"{RELEASES}/{dataset.release}/{asset}"


def fetch(dataset: Dataset, season: int | None, client: httpx.Client) -> pl.DataFrame | None:
    """Download one asset. Returns None when the season simply doesn't exist yet.

    Not every release publishes a gzipped variant — ftn_charting and
    pbp_participation ship plain CSV — so fall back rather than silently
    recording zero rows.
    """
    url = _url(dataset, season)
    response = client.get(url, follow_redirects=True, timeout=180.0)

    if response.status_code == 404 and url.endswith(".gz"):
        url = url[: -len(".gz")]
        response = client.get(url, follow_redirects=True, timeout=180.0)

    if response.status_code == 404:
        return None
    response.raise_for_status()

    raw = gzip.decompress(response.content) if url.endswith(".gz") else response.content
    # Schemas drift across seasons (columns added, types widened), so infer
    # generously rather than trusting the first few hundred rows.
    return pl.read_csv(io.BytesIO(raw), infer_schema_length=20_000, ignore_errors=True)


def sync(
    out_root: Path,
    seasons: range,
    datasets: tuple[Dataset, ...] = DATASETS,
    *,
    overwrite: bool = False,
) -> dict[str, int]:
    """Mirror datasets to Parquet. Returns rows written per dataset."""
    written: dict[str, int] = {}

    with httpx.Client(headers={"user-agent": "ffe-model/0.0"}) as client:
        for dataset in datasets:
            target_dir = out_root / dataset.name
            target_dir.mkdir(parents=True, exist_ok=True)
            total = 0

            season_list: list[int | None] = list(seasons) if dataset.per_season else [None]

            for season in season_list:
                label = str(season) if season is not None else "all"
                path = target_dir / f"{label}.parquet"

                if path.exists() and not overwrite:
                    total += pl.scan_parquet(path).select(pl.len()).collect().item()
                    continue

                frame = fetch(dataset, season, client)
                if frame is None:
                    continue

                frame.write_parquet(path, compression="zstd")
                total += frame.height
                print(f"  {dataset.name}/{label}: {frame.height:,} rows, {frame.width} cols")

            written[dataset.name] = total

    return written


if __name__ == "__main__":
    import sys

    root = Path(sys.argv[1] if len(sys.argv) > 1 else "data/lake")
    end = int(sys.argv[2]) if len(sys.argv) > 2 else 2026

    print(f"syncing nflverse {FIRST_SEASON}-{end} -> {root}")
    counts = sync(root, range(FIRST_SEASON, end + 1))

    print("\nrows per dataset:")
    for name, count in sorted(counts.items()):
        flag = "  [train-time only]" if name in TRAIN_TIME_ONLY else ""
        print(f"  {name:20s} {count:>12,}{flag}")
