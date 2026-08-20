"""v2 — v1's projections, adjusted for the defense each player actually faces.

v1 asks what a player does. It does not ask who he does it against, which means
a receiver drawing the league's stingiest secondary and one drawing its softest
get the same number. Managers know that is wrong, and it is the most common
reason they distrust a projection that is otherwise well calibrated.

The adjustment is deliberately conservative, for three reasons.

**It is applied to the whole position group, not to individuals.** A defense
acts on an offence, and eleven receivers cannot each independently gain 8% of
the targets. So the signal is "points allowed to this position, per game,
credited for the offences faced" — a team-level quantity applied uniformly.

**It is shrunk hard.** Opponent-adjusted points allowed is a noisy estimate off
a handful of games, and the honest prior is that most of a player's week is
about him rather than his opponent. `MATCHUP_WEIGHT` is the share of the gap
between a defense and the league mean that is allowed to reach the projection,
and it is small on purpose.

**It is capped.** Even a genuinely extreme matchup does not move a projection
by half, and an uncapped ratio would let one lopsided early-season sample do
exactly that.

Whether any of this is an improvement is an empirical question, and the answer
is not assumed here. `model/backtest/run_ladder.py` scores v2 against v1 out of
sample; if it does not win, it does not ship.

**It did not win.** Walk-forward over 2024-25, 10,979 player-weeks:

    v1-usage    MAE 4.568
    weight 0.35 MAE 4.564   (+0.09%)
    weight 0.70 MAE 4.570   (worse than v1)
    weight 1.00 MAE 4.578   (worse than v1)

The shape of that is the finding. A real signal applied more strongly helps
more; this one degrades monotonically, which is what a variable with almost no
predictive content looks like once you stop shrinking it away. The sliver of
gain at 0.35 is the adjustment being small enough not to do damage, not the
adjustment being right.

That is consistent with what the usage model already does: once targets and
carries are projected properly, the opponent adds little on top, because volume
is far more predictive of a fantasy week than who is on the other side of it.
Defensive scheme is still worth showing a manager — a two-high shell really
does move a receiver's ceiling and a back's floor in opposite directions — but
it belongs beside the projection as context, not multiplied into the mean where
it makes the number measurably worse.

Kept, unwired, because a negative result nobody records is a negative result
somebody repeats. Re-run the sweep with `model/backtest/run_ladder.py` before
reviving it; if a better matchup feature turns up, this is the harness for it.
"""

from __future__ import annotations

from model.backtest.harness import Prediction
from model.features.store import AsOf, FeatureStore
from model.features.team_context import defense_vs_position

#: Share of the gap between a defense and league average that reaches a
#: projection. Low because the estimate is noisy and the player matters more
#: than the opponent; the backtest is what decides whether it should move.
MATCHUP_WEIGHT = 0.35

#: Hard bounds on the multiplier, so one lopsided sample cannot rewrite a week.
MIN_MULTIPLIER = 0.85
MAX_MULTIPLIER = 1.15

#: Scoring used only to measure what defenses concede. Each league still scores
#: its own way; this is a common yardstick for ranking opponents.
YARDSTICK: dict[str, float] = {
    "passing_yards": 0.04, "passing_tds": 4.0, "passing_interceptions": -1.0,
    "rushing_yards": 0.1, "rushing_tds": 6.0,
    "receptions": 1.0, "receiving_yards": 0.1, "receiving_tds": 6.0,
}


def matchup_multipliers(
    store: FeatureStore, as_of: AsOf, seasons_back: int = 1, weight: float = MATCHUP_WEIGHT
) -> dict[tuple[str, str], float]:
    """Multiplier per (defense, position), centred on 1.0.

    Above 1.0 means this defense concedes more than average to the position, so
    a player facing it is projected up. Everything is measured from completed
    games only, through the same as-of store the rest of the model uses, so a
    backtest cannot see a defense's future.
    """
    allowed = defense_vs_position(store, as_of, YARDSTICK, seasons_back=seasons_back)
    if allowed.height == 0:
        return {}

    out: dict[tuple[str, str], float] = {}
    for position in allowed["position"].unique().to_list():
        subset = allowed.filter(allowed["position"] == position)
        values = subset["adjusted"].to_list()
        if not values:
            continue

        league_mean = sum(values) / len(values)
        if league_mean <= 0:
            continue

        for row in subset.to_dicts():
            ratio = float(row["adjusted"]) / league_mean
            # Shrink toward 1.0, then clamp.
            shrunk = 1.0 + (ratio - 1.0) * weight
            out[(str(row["defense"]), str(position))] = max(
                MIN_MULTIPLIER, min(MAX_MULTIPLIER, shrunk)
            )

    return out


def apply_matchup(
    predictions: list[Prediction],
    multipliers: dict[tuple[str, str], float],
    opponent_of: dict[str, str],
    position_of: dict[str, str],
) -> list[Prediction]:
    """Scale each mean by its player's matchup. Spread is left alone.

    The spread is not widened or narrowed here on purpose. v1's intervals are
    calibrated — an 80% interval contains about 84% of outcomes — and that
    calibration was measured against unadjusted spreads. Changing the mean and
    the spread in one step would make a regression in either impossible to
    attribute.
    """
    adjusted: list[Prediction] = []
    for prediction in predictions:
        opponent = opponent_of.get(prediction.player_id)
        position = position_of.get(prediction.player_id)

        multiplier = 1.0
        if opponent is not None and position is not None:
            multiplier = multipliers.get((opponent, position), 1.0)

        adjusted.append(
            Prediction(
                player_id=prediction.player_id,
                mean=prediction.mean * multiplier,
                sd=prediction.sd,
            )
        )

    return adjusted


def build(
    store: FeatureStore,
    as_of: AsOf,
    rules: dict[str, float],
    weight: float = MATCHUP_WEIGHT,
) -> list[Prediction]:
    """v1's projections with the matchup applied. The harness entry point.

    Opponent and position come from the schedule and from completed games only,
    read through the same as-of store, so nothing here can see the week being
    predicted.
    """
    from model.models import v1_usage

    base = v1_usage.build(store, as_of, rules)
    if not base:
        return []

    multipliers = matchup_multipliers(store, as_of, weight=weight)
    if not multipliers:
        return base

    # Who each team plays this week.
    schedules = store.raw("schedules").pl()
    week = schedules.filter(
        (schedules["season"] == as_of.season) & (schedules["week"] == as_of.week)
    )

    opponent_of_team: dict[str, str] = {}
    for row in week.iter_rows(named=True):
        home, away = str(row["home_team"]), str(row["away_team"])
        opponent_of_team[home] = away
        opponent_of_team[away] = home

    # Each player's team and position, from games already played.
    history = store.as_of("player_stats", as_of, seasons_back=1).pl()
    if history.height == 0:
        return base

    latest = (
        history.sort(["season", "week"])
        .group_by("player_id")
        .last()
        .select(["player_id", "team", "position"])
    )

    opponent_of: dict[str, str] = {}
    position_of: dict[str, str] = {}
    for row in latest.to_dicts():
        player_id = str(row["player_id"])
        team = row["team"]
        if team is None:
            continue
        opponent = opponent_of_team.get(str(team))
        if opponent is not None:
            opponent_of[player_id] = opponent
        if row["position"] is not None:
            position_of[player_id] = str(row["position"])

    return apply_matchup(base, multipliers, opponent_of, position_of)
