"""Does the rookie prior beat knowing nothing about the rookie?

The repository's rule is that a model is measured against the rung below it and
ships only if it wins out of sample. The rookie prior has no rung below it — v1
emits no row at all for a player with no history — so the honest baseline is the
simplest thing that still produces a number for the same players:

    **flat** — every rookie at a position gets the average rookie at that
    position. No draft capital, no depth chart.

That is the comparison that matters. Draft capital is either worth something
above "he is a rookie receiver" or it is not, and this is what decides it.

A second baseline is included because it is the one a fantasy site would reach
for by default:

    **replacement** — every rookie gets zero. This is what the application
    actually did before the prior existed, and it is here to size the cost of
    the missing row rather than to be a serious competitor.

Scope: `weekly_rosters` only covers 2024 onward in the lake, and the rookie
universe is built from rosters, so the evaluation window is the 2024 and 2025
classes. Two classes is thin and the result is reported as such.

    uv run --project model python model/backtest/run_rookie_gate.py 2024 2025
"""

from __future__ import annotations

import sys

import polars as pl

from model.backtest.harness import (
    BacktestResult,
    Prediction,
    WeekResult,
    actual_points,
    default_lake,
    skill_score,
)
from model.backtest.scoring import crps_gaussian, log_score_gaussian, mae, rmse
from model.features.scoring import score_expression
from model.features.store import AsOf, FeatureStore
from model.models import rookie_prior

SLEEPER_RULES: dict[str, float] = {
    "pass_yd": 0.04, "pass_td": 4.0, "pass_int": -1.0,
    "rush_yd": 0.1, "rush_td": 6.0,
    "rec": 1.0, "rec_yd": 0.1, "rec_td": 6.0,
}

SCORING: dict[str, float] = {
    "passing_yards": 0.04, "passing_tds": 4.0, "passing_interceptions": -1.0,
    "rushing_yards": 0.1, "rushing_tds": 6.0,
    "receptions": 1.0, "receiving_yards": 0.1, "receiving_tds": 6.0,
}


def _score(line: dict[str, float]) -> float:
    frame = pl.DataFrame([line])
    expression, _ = score_expression(SLEEPER_RULES, set(frame.columns))
    return max(0.0, float(frame.select(expression.alias("p"))["p"][0]))


def prior_model(store: FeatureStore, as_of: AsOf) -> list[Prediction]:
    """The shipping rookie prior: draft capital, depth chart, rookie rates."""
    lines, spreads, _ = rookie_prior.project_rookie_stat_lines(store, as_of)
    return [
        Prediction(player_id=pid, mean=_score(line), sd=spreads.get(pid, 7.0))
        for pid, line in lines.items()
    ]


def flat_model(store: FeatureStore, as_of: AsOf) -> list[Prediction]:
    """Every rookie at a position gets the average rookie at that position.

    Same players, same spread, same scoring — the only thing removed is the
    information carried by draft slot and depth chart.
    """
    priors = rookie_prior.fit(store, as_of)
    if not priors.volume:
        return []

    flat_line: dict[str, dict[str, float]] = {}
    for position in {p for p, _ in priors.volume}:
        line: dict[str, float] = {}
        for stat in rookie_prior.VOLUME_STATS:
            curve = priors.volume.get((position, stat))
            line[stat] = curve.fallback if curve else 0.0
        for stat, denominator in rookie_prior.RATE_STATS:
            rate = priors.rates.get((position, f"{stat}/{denominator}"))
            line[stat] = rate * line.get(denominator, 0.0) if rate is not None else 0.0
        flat_line[position] = line

    return [
        Prediction(
            player_id=rookie.player_id,
            mean=_score(flat_line.get(rookie.position, {})),
            sd=priors.spread.get(rookie.position, 7.0),
        )
        for rookie in rookie_prior.current_rookies(store, as_of)
        if rookie.position in flat_line
    ]


def replacement_model(store: FeatureStore, as_of: AsOf) -> list[Prediction]:
    """What the app did before: no projection, which reads as zero."""
    priors = rookie_prior.fit(store, as_of)
    return [
        Prediction(player_id=r.player_id, mean=0.0, sd=priors.spread.get(r.position, 7.0))
        for r in rookie_prior.current_rookies(store, as_of)
    ]


def evaluate(
    store: FeatureStore, model, name: str, seasons: range, weeks: range
) -> BacktestResult:
    """Walk forward over rookie player-weeks only.

    Deliberately not `harness.walk_forward`: that scores every player a model
    emits, and here the whole point is to restrict the comparison to the players
    the prior exists for. Everything else — the inner join against actuals, the
    refusal to impute a zero for a player who did not appear — is the same.
    """
    results: list[WeekResult] = []

    for season in seasons:
        for week in weeks:
            as_of = AsOf(season, week)
            predictions = model(store, as_of)
            if not predictions:
                continue

            truth = actual_points(store, season, week, SCORING)
            if truth.height == 0:
                continue

            predicted = pl.DataFrame(
                {
                    "player_id": [p.player_id for p in predictions],
                    "mean": [p.mean for p in predictions],
                    "sd": [max(1e-6, p.sd) for p in predictions],
                }
            )
            joined = predicted.join(truth, on="player_id", how="inner")
            if joined.height == 0:
                continue

            mean = joined["mean"].to_numpy()
            sd = joined["sd"].to_numpy()
            actual = joined["actual"].to_numpy()

            results.append(
                WeekResult(
                    season=season,
                    week=week,
                    n=joined.height,
                    mae=mae(mean, actual),
                    rmse=rmse(mean, actual),
                    crps=crps_gaussian(mean, sd, actual),
                    log_score=log_score_gaussian(mean, sd, actual),
                )
            )

    return BacktestResult(model_name=name, weeks=results)


if __name__ == "__main__":
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2025

    contenders = [
        ("replacement", replacement_model),
        ("flat-rookie", flat_model),
        ("draft-prior", prior_model),
    ]

    with FeatureStore(default_lake()) as store:
        results = [
            evaluate(store, model, name, range(first, last + 1), range(1, 18))
            for name, model in contenders
        ]

    print(f"rookie player-weeks, {first}-{last}, walk-forward out of sample\n")
    baseline = next(r for r in results if r.model_name == "flat-rookie")
    for result in results:
        print(
            f"{result.model_name:14s} n={result.n:>6,}  MAE={result.mae:6.3f}  "
            f"RMSE={result.rmse:6.3f}  CRPS={result.crps:6.3f}"
        )

    prior = next(r for r in results if r.model_name == "draft-prior")
    gain = skill_score(prior.mae, baseline.mae)
    print(
        f"\ndraft-prior vs flat-rookie: MAE skill {gain:+.2%} -> "
        f"{'SHIPS' if gain > 0 else 'DOES NOT SHIP'}"
    )
