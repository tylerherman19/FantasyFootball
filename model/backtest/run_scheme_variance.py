"""Does defensive scheme move the *shape* of a forecast, if not its level?

    uv run --project model python model/backtest/run_scheme_variance.py 2022 2025

Two versions of a matchup adjustment have already been built, measured and
declined. Both were gated on MAE — a test of the mean. Neither said anything
about the spread, and the spread is a separate claim: a defense that plays two
safeties deep can leave a receiver's expected line untouched while removing the
outcomes at the top of his range. Mean unchanged, variance lower. MAE cannot see
that; CRPS can.

This matters beyond curiosity because the product already asserts it. The model
page says a two-high shell moves "a receiver's ceiling and a back's floor in
opposite directions", which is either a measurable fact or a decorative
sentence. This is the measurement that decides which.

**Method.** For each player-week the model forecast, take the standardised
residual z = (actual - mean) / sd. If the stated spread is right *and*
scheme carries no information about spread, then sd(z) is 1.0 in every bucket.
So: bucket player-weeks by the shell posture of the defense faced, split by
position, and compare sd(z) across buckets. A real effect shows up as WR and RB
moving in opposite directions — which is the specific claim, not just "some
buckets differ", and is much harder to produce by chance than a single
difference in one bucket.

**The shell index is computed from prior seasons only.** The shipped artifact
pools 2024 and 2025, which would let a 2024 residual be explained by a defense's
2024 behaviour — the same play-by-play the residual came from. Every index here
is built strictly from seasons before the one being scored, so a week is judged
by what was knowable before it.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from functools import partial
from pathlib import Path

import numpy as np
import polars as pl

from model.backtest.harness import SKILL_POSITIONS, actual_points, default_lake
from model.backtest.run_ladder import SCORING, SLEEPER_RULES
from model.features.store import AsOf, FeatureStore
from model.models import v1_usage

#: A defense needs enough snaps for its posture to be a fact rather than a
#: sample. Roughly half a season of dropbacks.
MIN_DROPBACKS = 250

#: Per position-and-bucket. Below this the sd of a ratio is wider than any
#: effect worth shipping, so the bucket is reported but not counted as evidence.
MIN_BUCKET = 300


def _zscore(values: dict[str, float]) -> dict[str, float]:
    """Standardise across the 32 teams. Population sd — this is the whole league."""
    if not values:
        return {}
    arr = np.array(list(values.values()), dtype=float)
    mean, sd = float(arr.mean()), float(arr.std())
    if sd == 0.0:
        return {team: 0.0 for team in values}
    return {team: (value - mean) / sd for team, value in values.items()}


def shell_index(store: FeatureStore, seasons: list[int]) -> dict[str, float]:
    """Shell posture per defense, from the given seasons' play-by-play.

    Mirrors `model/export_defense.py`: the average of four z-scores, each
    oriented so that positive means "keeps everything in front of it". Kept
    deliberately in sync — a variance effect measured against a *different*
    definition of shell than the one the site displays would not be evidence
    about the thing the site displays.
    """
    if not seasons:
        return {}

    pbp = store.raw("pbp")
    seasons_sql = ",".join(str(s) for s in seasons)

    passing = pbp.query(
        "pbp",
        f"""
        select
            defteam as team,
            count(*) as dropbacks,
            avg(coalesce(air_yards, 0)) as adot,
            avg(case when coalesce(air_yards, 0) >= 20 then 1.0 else 0.0 end) as deep_rate,
            sum(coalesce(yards_after_catch, 0)) as yac,
            sum(coalesce(receiving_yards, yards_gained, 0)) as rec_yards
        from pbp
        where season in ({seasons_sql})
          and pass = 1 and defteam is not null
        group by defteam
        """,
    ).pl()

    rushing = pbp.query(
        "pbp",
        f"""
        select defteam as team, avg(epa) as rush_epa, count(*) as rushes
        from pbp
        where season in ({seasons_sql})
          and rush = 1 and defteam is not null and epa is not null
        group by defteam
        """,
    ).pl()

    keep = {
        row["team"]
        for row in passing.iter_rows(named=True)
        if row["dropbacks"] is not None and row["dropbacks"] >= MIN_DROPBACKS
    }
    if not keep:
        return {}

    # Oriented so positive = softer shell, matching export_defense.py: low aDOT
    # allowed, few deep attempts allowed, lots of yards after the catch (the
    # signature of surrendering short throws), and rushing yielded.
    adot = _zscore({r["team"]: -float(r["adot"] or 0) for r in passing.iter_rows(named=True) if r["team"] in keep})
    deep = _zscore({r["team"]: -float(r["deep_rate"] or 0) for r in passing.iter_rows(named=True) if r["team"] in keep})
    yac = _zscore(
        {
            r["team"]: float(r["yac"] or 0) / max(1.0, float(r["rec_yards"] or 0))
            for r in passing.iter_rows(named=True)
            if r["team"] in keep
        }
    )
    rush = _zscore({r["team"]: float(r["rush_epa"] or 0) for r in rushing.iter_rows(named=True) if r["team"] in keep})

    return {
        team: (adot.get(team, 0.0) + deep.get(team, 0.0) + yac.get(team, 0.0) + rush.get(team, 0.0)) / 4.0
        for team in keep
    }


def opponents(store: FeatureStore, season: int, week: int) -> dict[str, str]:
    """team -> the defense it faces this week."""
    rows = (
        store.raw("schedules")
        .query("schedules", f"select home_team, away_team from schedules where season = {season} and week = {week}")
        .pl()
    )
    table: dict[str, str] = {}
    for row in rows.iter_rows(named=True):
        home, away = row["home_team"], row["away_team"]
        if home is None or away is None:
            continue
        table[str(home)] = str(away)
        table[str(away)] = str(home)
    return table


def player_teams(store: FeatureStore, season: int, week: int) -> dict[str, tuple[str, str]]:
    """player_id -> (team, position), from the roster in force that week."""
    rows = (
        store.raw("weekly_rosters")
        .query(
            "weekly_rosters",
            f"""
            select gsis_id, team, position
            from weekly_rosters
            where season = {season} and week = {week} and gsis_id is not null
            """,
        )
        .pl()
    )
    return {
        str(r["gsis_id"]): (str(r["team"] or ""), str(r["position"] or ""))
        for r in rows.iter_rows(named=True)
    }


def collect(store: FeatureStore, seasons: range, weeks: range) -> pl.DataFrame:
    """Every scored player-week, with the shell posture it faced."""
    model = partial(v1_usage.build, rules=SLEEPER_RULES)
    frames: list[pl.DataFrame] = []

    for season in seasons:
        # Strictly prior seasons. The first season of the range therefore has no
        # index and contributes nothing — that is the cost of not leaking.
        history = [s for s in range(season - 3, season) if s >= 2016]
        index = shell_index(store, history)
        if not index:
            print(f"  {season}: no prior-season index, skipped")
            continue
        print(f"  {season}: shell index from {history}, {len(index)} defenses")

        for week in weeks:
            predictions = model(store, AsOf(season, week))
            if not predictions:
                continue
            truth = actual_points(store, season, week, SCORING, SKILL_POSITIONS)
            if truth.height == 0:
                continue

            schedule = opponents(store, season, week)
            roster = player_teams(store, season, week)
            if not schedule or not roster:
                continue

            rows = []
            for p in predictions:
                entry = roster.get(p.player_id)
                if entry is None:
                    continue
                team, position = entry
                defense = schedule.get(team)
                if defense is None or defense not in index:
                    continue
                if p.sd <= 0:
                    continue
                rows.append(
                    {
                        "player_id": p.player_id,
                        "position": position,
                        "mean": p.mean,
                        "sd": p.sd,
                        "shell": index[defense],
                    }
                )

            if not rows:
                continue
            frames.append(
                pl.DataFrame(rows)
                .join(truth, on="player_id", how="inner")
                .with_columns(season=pl.lit(season, dtype=pl.Int32))
            )

    if not frames:
        return pl.DataFrame()
    return pl.concat(frames, how="vertical")


def report(data: pl.DataFrame) -> dict:
    """sd of the standardised residual, by position and shell tercile.

    Returns the finding as data as well as printing it, because the site quotes
    these numbers and a number typed into a page by hand is a number that goes
    stale silently. Everything the scheme page asserts about what scheme is
    worth is read from the artifact this produces.
    """
    print(f"\n{data.height:,} player-weeks, {data['position'].n_unique()} positions\n")

    shells = data["shell"].to_numpy()
    low, high = float(np.quantile(shells, 1 / 3)), float(np.quantile(shells, 2 / 3))
    print(f"shell terciles: loaded box < {low:+.3f} < neutral < {high:+.3f} < soft shell\n")

    print(f"{'pos':5s} {'bucket':12s} {'n':>7s} {'sd(z)':>8s} {'mean(z)':>9s} {'p90 rate':>9s}")
    print("-" * 56)

    verdicts: dict[str, dict[str, float]] = defaultdict(dict)
    buckets_out: list[dict] = []

    for position in ("QB", "RB", "WR", "TE"):
        subset = data.filter(pl.col("position") == position)
        if subset.height == 0:
            continue

        for name, predicate in (
            ("loaded box", pl.col("shell") < low),
            ("neutral", (pl.col("shell") >= low) & (pl.col("shell") <= high)),
            ("soft shell", pl.col("shell") > high),
        ):
            bucket = subset.filter(predicate)
            if bucket.height == 0:
                continue

            z = (bucket["actual"].to_numpy() - bucket["mean"].to_numpy()) / bucket["sd"].to_numpy()
            sd_z = float(np.std(z))
            # Share landing above the stated 90th percentile. A ceiling effect
            # shows here even when the whole-distribution sd barely moves.
            p90 = float(np.mean(z > 1.2816))

            flag = "" if bucket.height >= MIN_BUCKET else "  (thin)"
            print(f"{position:5s} {name:12s} {bucket.height:7,d} {sd_z:8.3f} {float(np.mean(z)):+9.3f} {p90:9.1%}{flag}")

            if bucket.height >= MIN_BUCKET:
                verdicts[position][name] = sd_z

            buckets_out.append(
                {
                    "position": position,
                    "bucket": name,
                    "n": bucket.height,
                    "residualSd": round(sd_z, 4),
                    "meanZ": round(float(np.mean(z)), 4),
                    "aboveP90": round(p90, 4),
                    "thin": bucket.height < MIN_BUCKET,
                }
            )

        print()

    print("=" * 56)
    print("soft shell vs loaded box, ratio of residual sd:\n")

    spreads: dict[str, float] = {}
    for position, buckets in verdicts.items():
        soft, loaded = buckets.get("soft shell"), buckets.get("loaded box")
        if soft is None or loaded is None:
            continue
        spreads[position] = soft / loaded
        print(f"  {position:4s} {soft / loaded:.3f}   (soft {soft:.3f} / loaded {loaded:.3f})")

    print()
    wr, rb = spreads.get("WR"), spreads.get("RB")
    finding = {
        "n": data.height,
        "seasons": sorted({int(s) for s in data["season"].to_list()}) if "season" in data.columns else [],
        "terciles": {"loadedBoxBelow": round(low, 4), "softShellAbove": round(high, 4)},
        "buckets": buckets_out,
        "ratios": {k: round(v, 4) for k, v in spreads.items()},
    }
    if wr is None or rb is None:
        print("VERDICT: insufficient data for the WR/RB opposition test.")
        finding["verdict"] = "insufficient"
        return finding

    # The claim under test is directional and specific: a soft shell should
    # compress a receiver's range and widen a back's. Two ratios differing in
    # the same direction is a story about the whole league's variance that week,
    # not about scheme.
    print(f"the claim: WR ratio < 1 (soft shell caps the ceiling), RB ratio > 1 (light box opens the floor)")
    print(f"measured:  WR {wr:.3f}, RB {rb:.3f}, separation {abs(wr - rb):.3f}")
    print()
    finding["separation"] = round(abs(wr - rb), 4)
    if wr < 0.95 and rb > 1.05:
        finding["verdict"] = "directional"
        print("VERDICT: directionally as claimed. Worth fitting a multiplier and gating on CRPS.")
    elif abs(wr - rb) < 0.05:
        finding["verdict"] = "declined"
        print("VERDICT: DECLINED — WR and RB move together, which is not a scheme effect.")
    else:
        finding["verdict"] = "partial"
        print("VERDICT: partial. Separation exists but not in the claimed direction; not shippable.")
    return finding


if __name__ == "__main__":
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2022
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2025

    with FeatureStore(default_lake()) as store:
        print(f"collecting {first}-{last} ...")
        data = collect(store, range(first, last + 1), range(1, 18))
        if data.height == 0:
            print("no data")
            raise SystemExit(1)
        finding = report(data)

        out = Path("model/artifacts/scheme-variance.json")
        out.write_text(json.dumps(finding, indent=2) + "\n")
        print(f"\nfinding -> {out}")
