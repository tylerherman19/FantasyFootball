"""v3 — matchup applied to opportunity, not to the point estimate.

v2 scaled each player's projected *points* by what his opponent concedes to his
position. It was measured and declined: walk-forward over 2024-25, MAE degraded
monotonically as the adjustment was applied more strongly — 4.564 at weight 0.35,
4.570 at 0.70, 4.578 at 1.00, against v1's 4.568. That shape is what a variable
with almost no predictive content looks like.

The right conclusion from that is not "matchup is worthless". It is that the
quantity being adjusted was wrong.

v1's own finding is that **volume is sticky and efficiency is noise** — that is
the whole reason it beats Marcel. So a matchup adjustment applied to points is
adjusting a number that is mostly efficiency, which is the half that does not
persist and cannot be predicted from a season of opponent data. If a defense
influences a fantasy week in any recoverable way, it should show up in the
half that *is* predictable: how many targets and carries the offence generates
against it.

So v3 changes exactly one thing from v2. It adjusts the **opportunity** terms —
attempts, carries, targets — by what the defense allows in opportunity terms,
and leaves the rates entirely alone. Points then fall out of the same identity
v1 already uses.

**It did not win either.** Walk-forward over 2024-25, the same 10,979
player-weeks v2 was measured on:

    v1-usage    MAE 4.568   CRPS 3.312
    v3 w0.25    MAE 4.567   CRPS 3.312   (+0.02%)
    v3 w0.50    MAE 4.569   CRPS 3.313   (worse)
    v3 w1.00    MAE 4.581   CRPS 3.323   (worse)

The same monotone degradation as v2, and for the same reason: the sliver at the
lowest weight is the adjustment being too small to do damage, not the adjustment
being right. So the module is kept and left unwired, exactly as v2 is.

**This is the more useful of the two negatives.** v2 left an obvious escape
hatch — "you adjusted the wrong quantity" — and v3 is that hatch, taken
deliberately and closed. Opponent strength does not predict a fantasy week
through points, and it does not predict one through opportunity either, at least
not at the resolution a season of team-level data can measure. Two independent
attempts, the same shape of failure.

What that leaves is the reading v1 already implies: once a player's own targets
and carries are projected properly, the opponent has very little left to explain,
because usage is a property of the offence's plan and defenses do not change
plans much. The remaining places worth trying are finer-grained than this —
allocation *within* a position group by alignment and route depth, which needs
the charting data rather than box-score opportunity — and none of them should be
attempted without the same gate.

Scheme therefore stays where the evidence supports it: displayed beside a
projection, where a manager can see a two-high shell moving a receiver's ceiling
and a back's floor in opposite directions, and out of the mean, where it makes
the number measurably worse.

    uv run --project model python model/backtest/run_ladder.py 2024 2025
"""

from __future__ import annotations

import polars as pl

from model.backtest.harness import SKILL_POSITIONS, Prediction
from model.features.scheme import opponent_adjust
from model.features.scoring import score_expression
from model.features.store import AsOf, FeatureStore
from model.models import v1_usage

#: Share of the gap between a defense and the league mean that reaches the
#: projection. Small on purpose: opponent-adjusted opportunity allowed is a
#: noisy estimate off a handful of games, and the honest prior is that most of a
#: player's usage is about his own role.
ALLOCATION_WEIGHT = 0.5

#: Hard bound on the multiplier. Even a genuinely extreme matchup does not
#: change a role by half, and an uncapped ratio lets one lopsided early-season
#: sample do exactly that.
MAX_ADJUSTMENT = 0.25

#: Opportunity stats, and which position group each belongs to.
OPPORTUNITY_STATS: tuple[str, ...] = ("attempts", "carries", "targets")


def opportunity_allowed(
    store: FeatureStore, as_of: AsOf, seasons_back: int = 1
) -> dict[tuple[str, str], float]:
    """Opponent-adjusted opportunity each defense concedes, per position.

    Returns `(defense, position) -> multiplier`, centred on 1.0, where above one
    means this defense allows more opportunity to that position than average.

    Opponent-adjusted for the same reason `defense_vs_position` is: a unit that
    happened to face four run-heavy offences looks stout against the pass until
    the schedule is divided out.
    """
    stats = store.as_of("player_stats", as_of, seasons_back=seasons_back).pl()
    if stats.height == 0:
        return {}

    present = [c for c in OPPORTUNITY_STATS if c in stats.columns]
    if not present:
        return {}

    scoped = stats.filter(
        pl.col("position").is_in(SKILL_POSITIONS)
        & pl.col("opponent_team").is_not_null()
        & pl.col("team").is_not_null()
    ).with_columns(
        pl.sum_horizontal([pl.col(c).cast(pl.Float64).fill_null(0.0) for c in present]).alias(
            "opportunity"
        )
    )
    if scoped.height == 0:
        return {}

    # One row per defense per game per position: the opportunity that unit
    # allowed that week.
    allowed = scoped.group_by(["opponent_team", "team", "season", "week", "position"]).agg(
        pl.col("opportunity").sum().alias("opportunity")
    )

    out: dict[tuple[str, str], float] = {}

    for position in SKILL_POSITIONS:
        subset = allowed.filter(pl.col("position") == position)
        if subset.height < 32:
            continue

        adjusted = opponent_adjust(
            subset,
            unit_col="opponent_team",
            opponent_col="team",
            value_col="opportunity",
        )
        if adjusted.height == 0:
            continue

        column = "adjusted" if "adjusted" in adjusted.columns else "opportunity"
        mean = float(adjusted[column].mean() or 0.0)
        if mean <= 0:
            continue

        unit_column = "opponent_team" if "opponent_team" in adjusted.columns else adjusted.columns[0]
        for row in adjusted.to_dicts():
            value = row.get(column)
            unit = row.get(unit_column)
            if value is None or unit is None:
                continue
            out[(str(unit), position)] = float(value) / mean

    return out


def _opponents(store: FeatureStore, as_of: AsOf) -> dict[str, str]:
    """Who each team plays in the target week."""
    games = store.raw("schedules").pl().filter(
        (pl.col("season") == as_of.season) & (pl.col("week") == as_of.week)
    )
    out: dict[str, str] = {}
    for row in games.to_dicts():
        home, away = row.get("home_team"), row.get("away_team")
        if home and away:
            out[str(home)] = str(away)
            out[str(away)] = str(home)
    return out


def _team_of(store: FeatureStore, as_of: AsOf) -> dict[str, str]:
    """Most recent team per player, from completed games."""
    stats = store.as_of("player_stats", as_of, seasons_back=1).pl()
    if stats.height == 0 or "team" not in stats.columns:
        return {}
    latest = (
        stats.drop_nulls("team")
        .sort(["season", "week"])
        .group_by("player_id")
        .agg(pl.col("team").last())
    )
    return {str(r["player_id"]): str(r["team"]) for r in latest.to_dicts()}


def build(
    store: FeatureStore,
    as_of: AsOf,
    rules: dict[str, float],
    weight: float = ALLOCATION_WEIGHT,
) -> list[Prediction]:
    """v1's stat lines, with opportunity nudged by the defense faced."""
    lines, _ = v1_usage.project_with_explanations(store, as_of)
    if not lines:
        return []

    allowed = opportunity_allowed(store, as_of)
    opponents = _opponents(store, as_of)
    teams = _team_of(store, as_of)

    history = store.as_of("player_stats", as_of, seasons_back=3).pl()
    frame = history.filter(pl.col("position").is_in(SKILL_POSITIONS))
    position_of = {
        str(row["player_id"]): str(row["position"])
        for row in frame.select(["player_id", "position"]).unique(subset=["player_id"]).to_dicts()
    }

    score, _unused = score_expression(rules, set(frame.columns))
    scored = frame.with_columns(score.alias("points"))
    points_sd = {
        row["position"]: float(row["sd"] or 7.0)
        for row in scored.group_by("position").agg(pl.col("points").std().alias("sd")).to_dicts()
    }
    multipliers = v1_usage._spread_multipliers()

    predictions: list[Prediction] = []

    for player_id, line in lines.items():
        position = position_of.get(player_id, "")
        team = teams.get(player_id)
        opponent = opponents.get(team) if team else None

        adjusted = dict(line)
        ratio = allowed.get((opponent, position)) if opponent else None

        if ratio is not None:
            # Shrunk toward 1 and then capped, in that order: the weight is the
            # belief, the cap is the guard against one lopsided sample.
            factor = 1.0 + weight * (ratio - 1.0)
            factor = max(1 - MAX_ADJUSTMENT, min(1 + MAX_ADJUSTMENT, factor))

            # Only the opportunity terms move. Rates are untouched, which is the
            # entire difference from v2 — and the reason to expect a different
            # answer, since rates are the half that does not persist.
            for stat in OPPORTUNITY_STATS:
                if stat in adjusted:
                    adjusted[stat] *= factor
            for stat, denominator in v1_usage.RATE_STATS:
                if stat in adjusted and denominator in line and line[denominator] > 0:
                    # Preserve rate: the yield per opportunity is unchanged, so
                    # the counting stat moves with its denominator.
                    adjusted[stat] = line[stat] * factor

        row = pl.DataFrame([adjusted])
        expression, _again = score_expression(rules, set(row.columns))
        mean = float(row.select(expression.alias("p"))["p"][0])

        sd = points_sd.get(position, 7.0) * multipliers.get(position, 1.0)
        predictions.append(Prediction(player_id=player_id, mean=max(0.0, mean), sd=sd))

    return predictions
