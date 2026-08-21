"""Aging curves, measured rather than asserted.

Dynasty valuation currently ages players with rules of thumb — the brief's §21
names the genre exactly: "RB over 27 = bad." That is a real pattern stated at the
wrong resolution. It cannot tell a 27-year-old three-down back from a
27-year-old committee back, it has nothing to say about a 24-year-old receiver
who has already been used hard, and it changes discontinuously on a birthday.

The honest version is a curve per position, fitted on what actually happened.

**The trap, and why the obvious fit is wrong.** Regressing production on age
across a population measures *survivorship*, not aging. The 32-year-olds still
playing are the ones good enough to still be playing, so the raw curve bends
upward at exactly the ages where careers are ending. Every serious treatment of
this in baseball uses the same fix, and it is the one used here: the **delta
method**. Only players who appear in two consecutive seasons contribute, and
what is measured is each player's *change* year over year. A player is compared
to himself, so his level cancels and only the age effect remains.

The delta method has a known bias of its own — it still conditions on surviving
into year two — so this is a floor on the decline, not a neutral estimate. That
is stated rather than corrected, because correcting it properly needs a
selection model this data cannot support.

What is produced, per position, is the expected proportional change in per-game
production from one age to the next, chained into a curve normalised to 1.0 at
each position's peak.

    uv run --project model python model/models/age_curves.py
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import UTC, datetime
from pathlib import Path

import polars as pl

from model.backtest.harness import SKILL_POSITIONS, default_lake
from model.features.store import AsOf, FeatureStore

#: Seasons of history to fit on. The whole NGS era.
FIRST_SEASON = 2016

#: Ages the curve covers. Outside this the sample is too thin to say anything.
MIN_AGE, MAX_AGE = 21, 36

#: Minimum games in a season for it to count as a season. A player with two
#: appearances is telling us about his injury, not his age.
MIN_GAMES = 6

#: Minimum paired observations before an age transition is trusted at all.
MIN_PAIRS = 20

#: Reference scoring, used only to have one number per player-season to age.
#: Never exported — the app scores stat lines per league.
_RULES: dict[str, float] = {
    "passing_yards": 0.04, "passing_tds": 4.0, "passing_interceptions": -1.0,
    "rushing_yards": 0.1, "rushing_tds": 6.0,
    "receptions": 1.0, "receiving_yards": 0.1, "receiving_tds": 6.0,
}


@dataclass(frozen=True)
class AgeTransition:
    """Expected proportional change in per-game production, age -> age + 1."""

    position: str
    from_age: int
    #: Median ratio of next season's per-game production to this season's.
    #: Median rather than mean: one player tripling his output should not drag
    #: a whole cohort upward, and production ratios are badly right-skewed.
    ratio: float
    pairs: int
    #: Spread of the individual ratios behind the median.
    #:
    #: The curve says what the *average* 26-year-old back does next year. This
    #: says how much individual backs differ from that average, and it is large
    #: — aging is a population tendency, not a schedule. A dynasty value quoted
    #: without it is a point estimate pretending to be a forecast.
    ratio_sd: float
    #: Standard error of the median itself, which shrinks with sample size.
    #: Distinct from ratio_sd: one is "how much do players differ", the other is
    #: "how well do we know the average".
    ratio_se: float


def _player_seasons(store: FeatureStore) -> pl.DataFrame:
    """Per-game production and age, one row per player-season."""
    stats = store.raw("player_stats").pl()
    if stats.height == 0:
        return pl.DataFrame()

    terms = [
        pl.col(stat).cast(pl.Float64).fill_null(0.0) * weight
        for stat, weight in _RULES.items()
        if stat in stats.columns
    ]
    if not terms:
        return pl.DataFrame()

    scored = (
        stats.filter((pl.col("season") >= FIRST_SEASON) & pl.col("position").is_in(SKILL_POSITIONS))
        .with_columns(pl.sum_horizontal(terms).alias("_points"))
        .group_by(["player_id", "position", "season"])
        .agg(
            pl.col("_points").sum().alias("points"),
            pl.len().alias("games"),
        )
        .filter(pl.col("games") >= MIN_GAMES)
        .with_columns((pl.col("points") / pl.col("games")).alias("per_game"))
    )

    # Age comes from rosters, which carry birth_date. Anyone without one cannot
    # contribute to an aging curve and is dropped rather than guessed at.
    rosters = store.raw("weekly_rosters").pl()
    if rosters.height == 0 or "birth_date" not in rosters.columns:
        return pl.DataFrame()

    births = (
        rosters.filter(pl.col("gsis_id").is_not_null())
        .drop_nulls("birth_date")
        .group_by("gsis_id")
        .agg(pl.col("birth_date").first())
        .select(
            pl.col("gsis_id").cast(pl.Utf8).alias("player_id"),
            pl.col("birth_date").cast(pl.Utf8).str.slice(0, 4).cast(pl.Int32, strict=False).alias("birth_year"),
        )
        .drop_nulls("birth_year")
    )

    return (
        scored.join(births, on="player_id", how="inner")
        # Season age: how old he was during that season, not on his birthday.
        .with_columns((pl.col("season") - pl.col("birth_year")).alias("age"))
        .filter(pl.col("age").is_between(MIN_AGE, MAX_AGE))
    )


def fit_transitions(seasons: pl.DataFrame) -> list[AgeTransition]:
    """The delta method:each player compared to himself, one year later."""
    if seasons.height == 0:
        return []

    later = seasons.select(
        pl.col("player_id"),
        (pl.col("season") - 1).alias("season"),
        pl.col("per_game").alias("next_per_game"),
    )

    paired = (
        seasons.join(later, on=["player_id", "season"], how="inner")
        # A season of essentially nothing makes the ratio explode; requiring a
        # real baseline keeps the denominator meaningful.
        .filter(pl.col("per_game") > 2.0)
        .with_columns((pl.col("next_per_game") / pl.col("per_game")).alias("ratio"))
    )
    if paired.height == 0:
        return []

    grouped = paired.group_by(["position", "age"]).agg(
        pl.col("ratio").median().alias("ratio"),
        pl.len().alias("pairs"),
        # Interquartile range rather than standard deviation: production ratios
        # have a long right tail (a backup who becomes a starter triples), and a
        # standard deviation would be dominated by a handful of those rather
        # than describing the typical player. Scaled to a normal-equivalent sd.
        ((pl.col("ratio").quantile(0.75) - pl.col("ratio").quantile(0.25)) / 1.349).alias("ratio_sd"),
    )

    return [
        AgeTransition(
            position=str(row["position"]),
            from_age=int(row["age"]),
            ratio=round(float(row["ratio"]), 4),
            pairs=int(row["pairs"]),
            ratio_sd=round(float(row["ratio_sd"] or 0.0), 4),
            # Standard error of a median is about 1.253 x sd / sqrt(n).
            ratio_se=round(
                1.253 * float(row["ratio_sd"] or 0.0) / max(1.0, float(row["pairs"]) ** 0.5), 4
            ),
        )
        for row in grouped.sort(["position", "age"]).to_dicts()
        if int(row["pairs"]) >= MIN_PAIRS
    ]


def build_curves(transitions: list[AgeTransition]) -> dict[str, dict[str, float]]:
    """Chain the year-over-year ratios into a level curve, peak normalised to 1.

    Chaining is what turns "what happens next year" into "where is he in his
    career", which is the question dynasty valuation actually asks.
    """
    curves: dict[str, dict[str, float]] = {}

    for position in {t.position for t in transitions}:
        steps = {t.from_age: t.ratio for t in transitions if t.position == position}
        if not steps:
            continue

        ages = sorted(steps)
        level = 1.0
        levels: dict[int, float] = {ages[0]: 1.0}
        for age in ages:
            level *= steps[age]
            levels[age + 1] = level

        peak = max(levels.values())
        if peak <= 0:
            continue
        curves[position] = {str(age): round(value / peak, 4) for age, value in sorted(levels.items())}

    return curves


def main() -> None:
    with FeatureStore(default_lake()) as store:
        seasons = _player_seasons(store)
        transitions = fit_transitions(seasons)

    curves = build_curves(transitions)
    if not curves:
        raise SystemExit("no aging curves could be fitted — check the lake")

    payload = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "method": "delta (paired consecutive seasons), median ratio, peak-normalised",
        "firstSeason": FIRST_SEASON,
        "minGames": MIN_GAMES,
        "minPairs": MIN_PAIRS,
        "caveat": (
            "The delta method removes survivorship in the level but not in the "
            "transition: only players who played both seasons contribute, so "
            "these curves understate decline. Treat as a floor."
        ),
        "curves": curves,
        "transitions": [asdict(t) for t in transitions],
    }

    out = Path(__file__).resolve().parents[1] / "artifacts" / "age-curves.json"
    out.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    print(f"wrote {out.name}")
    for position in sorted(curves):
        curve = curves[position]
        peak_age = max(curve, key=lambda a: curve[a])
        print(f"  {position}: peak {peak_age}, {len(curve)} ages")
        print("    " + "  ".join(f"{a}:{curve[a]:.2f}" for a in sorted(curve, key=int)))


if __name__ == "__main__":
    main()
