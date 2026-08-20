"""Team behaviour, and what a defense actually gives up.

Player usage is downstream of team behaviour. A back on a run-heavy, fast-paced
offence sees carries a back on a pass-first offence never will, and no amount of
player-level modelling recovers that if the team layer is missing. Three
features carry most of it:

**Pace** — how many plays a team runs. Fantasy volume is bounded by snaps, and
snaps vary far more between teams than most projections admit.

**PROE (pass rate over expected)** — whether a team passes more or less than its
situation calls for. Raw pass rate is mostly a record of game script: teams that
trail pass. Subtracting the league-average pass rate *for the same situation*
leaves the part that is identity rather than circumstance, which is the part
that persists into next week.

**Opponent-adjusted points allowed by position** — what a defense concedes, with
credit given for who it played. Raw "points allowed to receivers" ranks a team
that faced four bad offences above one that faced four good ones, which is how
matchup advice ends up backwards. The ridge adjustment in `scheme.py` separates
the defense's own effect from its schedule.

Together these answer the question a manager actually asks: this defense is
strong against receivers and soft against backs, and the offence facing it runs
often — so start the back.
"""

from __future__ import annotations

from dataclasses import dataclass

import polars as pl

from model.features.scheme import opponent_adjust
from model.features.store import AsOf, FeatureStore

#: Situations where play calling reflects identity rather than desperation.
#: Trailing by three scores in the fourth quarter tells you nothing about a team.
NEUTRAL_WP_LOW = 0.2
NEUTRAL_WP_HIGH = 0.8

#: Fantasy positions a defense is scored against.
SKILL_POSITIONS = ("QB", "RB", "WR", "TE")


@dataclass(frozen=True)
class TeamTendency:
    """One offence's behaviour over the observed window."""

    team: str
    season: int
    plays: int
    #: Offensive plays per game — the volume everything else divides up.
    plays_per_game: float
    #: Seconds of game clock per play in neutral situations. Lower is faster.
    seconds_per_play: float
    #: Raw dropback share.
    pass_rate: float
    #: Dropback share minus what the situation called for. Positive = pass-first.
    proe: float
    #: Neutral-situation pass rate, the cleanest read on intent.
    neutral_pass_rate: float


def _expected_pass_rate(plays: pl.DataFrame) -> pl.DataFrame:
    """League-average dropback rate for each down/distance/script bucket.

    This is the baseline PROE is measured against. Buckets rather than a fitted
    model on purpose: with a full season of plays every bucket is well
    populated, and a transparent baseline is easier to defend than a regression
    whose coefficients nobody inspects.
    """
    bucketed = plays.with_columns(
        pl.col("ydstogo").clip(1, 20).alias("togo_bucket"),
        # Score state matters in coarse bands, not exact points.
        pl.when(pl.col("score_differential") <= -9)
        .then(pl.lit("down_big"))
        .when(pl.col("score_differential") <= -1)
        .then(pl.lit("down"))
        .when(pl.col("score_differential") <= 8)
        .then(pl.lit("up"))
        .otherwise(pl.lit("up_big"))
        .alias("script"),
        # Two-minute situations have their own rules.
        (pl.col("half_seconds_remaining") <= 120).alias("late_half"),
    )

    league = bucketed.group_by(["down", "togo_bucket", "script", "late_half"]).agg(
        pl.col("is_pass").mean().alias("expected_pass_rate"),
        pl.len().alias("bucket_plays"),
    )

    return bucketed.join(league, on=["down", "togo_bucket", "script", "late_half"], how="left")


def team_tendencies(store: FeatureStore, as_of: AsOf, seasons_back: int = 1) -> list[TeamTendency]:
    """Pace and pass-rate identity per offence, from completed games only."""
    raw = store.as_of("pbp", as_of, seasons_back=seasons_back).pl()
    if raw.height == 0:
        return []

    plays = raw.filter(
        pl.col("posteam").is_not_null()
        & pl.col("down").is_not_null()
        # Dropbacks and designed runs only: penalties, kneels, spikes and
        # special teams are not play calls in the sense meant here.
        & (pl.col("qb_dropback").is_not_null() | (pl.col("rush_attempt") == 1))
        & (pl.col("play_type").is_in(["pass", "run"]))
    ).with_columns((pl.col("qb_dropback") == 1).cast(pl.Float64).alias("is_pass"))

    if plays.height == 0:
        return []

    with_expected = _expected_pass_rate(plays)

    neutral = with_expected.filter(
        (pl.col("wp") >= NEUTRAL_WP_LOW) & (pl.col("wp") <= NEUTRAL_WP_HIGH)
    )

    aggregated = with_expected.group_by(["posteam", "season"]).agg(
        pl.len().alias("plays"),
        pl.col("game_id").n_unique().alias("games"),
        pl.col("is_pass").mean().alias("pass_rate"),
        (pl.col("is_pass") - pl.col("expected_pass_rate")).mean().alias("proe"),
    )

    # Pace is measured in neutral situations only: a team protecting a lead
    # bleeds clock, and that is the score talking, not the offence.
    pace = neutral.group_by(["posteam", "season"]).agg(
        pl.col("is_pass").mean().alias("neutral_pass_rate"),
        # Elapsed clock between snaps, within a drive.
        (
            (pl.col("game_seconds_remaining").shift(1) - pl.col("game_seconds_remaining"))
            .filter(
                (pl.col("game_seconds_remaining").shift(1) - pl.col("game_seconds_remaining") > 0)
                & (pl.col("game_seconds_remaining").shift(1) - pl.col("game_seconds_remaining") < 60)
            )
            .mean()
            .alias("seconds_per_play")
        ),
    )

    merged = aggregated.join(pace, on=["posteam", "season"], how="left").drop_nulls("posteam")

    return [
        TeamTendency(
            team=row["posteam"],
            season=int(row["season"]),
            plays=int(row["plays"]),
            plays_per_game=float(row["plays"]) / max(1, int(row["games"])),
            seconds_per_play=float(row["seconds_per_play"] or 0.0),
            pass_rate=float(row["pass_rate"] or 0.0),
            proe=float(row["proe"] or 0.0),
            neutral_pass_rate=float(row["neutral_pass_rate"] or 0.0),
        )
        for row in merged.to_dicts()
    ]


def defense_vs_position(
    store: FeatureStore, as_of: AsOf, scoring: dict[str, float], seasons_back: int = 1
) -> pl.DataFrame:
    """Fantasy points each defense allows by position, adjusted for schedule.

    Returns one row per (defense, position) with `raw` and `adjusted` points
    allowed per game. The gap between them is the schedule: a defense whose
    adjusted figure is much worse than its raw one has been flattered by the
    offences it happened to face.
    """
    stats = store.as_of("player_stats", as_of, seasons_back=seasons_back).pl()
    if stats.height == 0:
        return pl.DataFrame()

    # `player_stats` already names the opponent, so no schedule join is needed —
    # and one less join is one less chance to silently drop half the rows.
    scored = stats.filter(
        pl.col("position").is_in(SKILL_POSITIONS)
        & pl.col("opponent_team").is_not_null()
        & pl.col("team").is_not_null()
    ).with_columns(
        sum(
            (pl.col(stat).fill_null(0) * weight)
            for stat, weight in scoring.items()
            if stat in stats.columns
        ).alias("points")
    )

    if scored.height == 0:
        return pl.DataFrame()

    # One row per defense per game per position: what that unit gave up.
    allowed = scored.group_by(["opponent_team", "team", "season", "week", "position"]).agg(
        pl.col("points").sum().alias("points")
    )

    frames = []
    for position in SKILL_POSITIONS:
        subset = allowed.filter(pl.col("position") == position)
        if subset.height == 0:
            continue

        # The unit is the defense; the "opponent" in the ridge is the offence it
        # faced, so a soft schedule stops reading as defensive skill.
        adjusted = opponent_adjust(
            subset,
            unit_col="opponent_team",
            opponent_col="team",
            value_col="points",
        ).rename({"opponent_team": "defense"}).with_columns(pl.lit(position).alias("position"))

        frames.append(adjusted)

    return pl.concat(frames) if frames else pl.DataFrame()
