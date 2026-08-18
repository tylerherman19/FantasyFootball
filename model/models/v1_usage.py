"""v1 — opportunity x efficiency, with empirical-Bayes shrinkage.

Marcel projects a player's *points*. That throws away the single most useful
fact in fantasy football: **volume is sticky and efficiency is noise.** A back
who got 18 carries last week will probably get carries again; the 6.1 yards he
averaged on them will not repeat. Projecting the two separately, and regressing
them at different rates, is where the real gain lives.

So a stat line is rebuilt from parts:

    points = sum over stats of (opportunities x rate x scoring weight)

- **Opportunities per game** — attempts, carries, targets. Sticky, lightly
  regressed.
- **Rates per opportunity** — yards per carry, TDs per target, catch rate.
  Noisy, regressed hard.

How hard is not a guess. For each (position, stat) we estimate the classic
empirical-Bayes constant

    k = within-player variance / between-player variance

which is the number of observations at which a player is exactly half regressed
toward the positional mean — the same idea baseball calls a stabilization point.
Touchdown rates come out with enormous k (regress nearly to the mean), target
share with small k (trust the player). We compute those constants from our own
data rather than importing someone's rules of thumb.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import polars as pl

from model.backtest.harness import SKILL_POSITIONS, Prediction
from model.features.scoring import score_expression
from model.features.store import AsOf, FeatureStore

#: Volume stats, modelled per game.
VOLUME_STATS: tuple[str, ...] = ("attempts", "carries", "targets")

#: Rate stats: (stat, denominator). Modelled per opportunity.
RATE_STATS: tuple[tuple[str, str], ...] = (
    ("completions", "attempts"),
    ("passing_yards", "attempts"),
    ("passing_tds", "attempts"),
    ("passing_interceptions", "attempts"),
    ("rushing_yards", "carries"),
    ("rushing_tds", "carries"),
    ("receptions", "targets"),
    ("receiving_yards", "targets"),
    ("receiving_tds", "targets"),
)

#: Games of history to consider. Older than this, roles have usually changed.
LOOKBACK_GAMES = 24

#: Recency half-life, in games.
HALF_LIFE_GAMES = 10.0

#: Floor on the shrinkage constant, so a stat that looks perfectly stable in a
#: small sample doesn't escape regression entirely.
MIN_K = 1.0


@dataclass(frozen=True)
class Shrinkage:
    """Empirical-Bayes constants for one (position, stat)."""

    position: str
    stat: str
    prior_mean: float
    k: float
    #: Residual standard deviation of the weekly stat, used for forecast spread.
    residual_sd: float


def estimate_shrinkage(frame: pl.DataFrame, stat: str, denominator: str | None) -> list[Shrinkage]:
    """Estimate k = within-variance / between-variance, per position.

    Intuition: if players differ a lot from each other but each is consistent
    week to week, believe the player (small k). If everyone looks the same and
    the week-to-week bounce is huge, believe the mean (large k).
    """
    out: list[Shrinkage] = []

    value = (
        (pl.col(stat) / pl.when(pl.col(denominator) > 0).then(pl.col(denominator)).otherwise(None))
        if denominator is not None
        else pl.col(stat)
    )

    prepared = frame.with_columns(value.cast(pl.Float64).alias("_v")).drop_nulls("_v")

    for position in SKILL_POSITIONS:
        subset = prepared.filter(pl.col("position") == position)
        if subset.height < 50:
            continue

        per_player = subset.group_by("player_id").agg(
            pl.col("_v").mean().alias("player_mean"),
            pl.col("_v").var().alias("player_var"),
            pl.len().alias("games"),
        )
        # Only players with enough games can tell us about week-to-week noise.
        established = per_player.filter(pl.col("games") >= 4).drop_nulls("player_var")
        if established.height < 10:
            continue

        within = float(established["player_var"].mean() or 0.0)
        between = float(established["player_mean"].var() or 0.0)

        # Between-player variance is itself inflated by sampling noise; subtract
        # the expected contribution so k isn't systematically understated.
        mean_games = float(established["games"].mean() or 1.0)
        between_true = max(between - within / mean_games, 1e-9)

        k = max(MIN_K, within / between_true) if within > 0 else MIN_K

        out.append(
            Shrinkage(
                position=position,
                stat=stat if denominator is None else f"{stat}/{denominator}",
                prior_mean=float(subset["_v"].mean() or 0.0),
                k=float(min(k, 500.0)),
                residual_sd=float(np.sqrt(within)) if within > 0 else 0.0,
            )
        )

    return out


def _weights(n: int) -> np.ndarray:
    return 0.5 ** (np.arange(n - 1, -1, -1, dtype=float) / HALF_LIFE_GAMES)


def _shrink(observed_total: float, observed_n: float, prior_mean: float, k: float) -> float:
    """Weighted average of what the player did and what the position does."""
    if observed_n + k <= 0:
        return prior_mean
    return (observed_total + prior_mean * k) / (observed_n + k)


def build(store: FeatureStore, as_of: AsOf, rules: dict[str, float]) -> list[Prediction]:
    """Project a full stat line per player, then score it under `rules`."""
    history = store.as_of("player_stats", as_of, seasons_back=3).pl()
    if history.height == 0:
        return []

    needed = {"player_id", "position", "season", "week"}
    columns = [c for c in {*VOLUME_STATS, *(s for s, _ in RATE_STATS), *(d for _, d in RATE_STATS)} if c in history.columns]

    frame = (
        history.filter(pl.col("position").is_in(SKILL_POSITIONS))
        .select(
            pl.col("player_id").cast(pl.Utf8),
            pl.col("position").cast(pl.Utf8),
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            *[pl.col(c).cast(pl.Float64).fill_null(0.0) for c in columns],
        )
        .sort(["player_id", "season", "week"])
    )
    if frame.height == 0 or not needed <= set(frame.columns):
        return []

    # Shrinkage constants are re-estimated at every as-of, from data available
    # then. Freezing them once would leak the future into early-season weeks.
    volume_shrinkage = {
        (s.position, s.stat): s
        for stat in VOLUME_STATS
        if stat in frame.columns
        for s in estimate_shrinkage(frame, stat, None)
    }
    rate_shrinkage = {
        (s.position, s.stat): s
        for stat, denominator in RATE_STATS
        if stat in frame.columns and denominator in frame.columns
        for s in estimate_shrinkage(frame, stat, denominator)
    }

    score, _ = score_expression(rules, set(frame.columns))
    scored = frame.with_columns(score.alias("points"))
    points_sd = {
        row["position"]: float(row["sd"] or 7.0)
        for row in scored.group_by("position").agg(pl.col("points").std().alias("sd")).to_dicts()
    }

    predictions: list[Prediction] = []

    for (player_id,), group in frame.group_by(["player_id"], maintain_order=True):
        recent = group.tail(LOOKBACK_GAMES)
        if recent.height == 0:
            continue

        position = str(recent["position"][-1])
        weights = _weights(recent.height)
        effective_games = float(weights.sum())

        projected: dict[str, float] = {}

        # 1. Volume per game, lightly regressed.
        for stat in VOLUME_STATS:
            if stat not in recent.columns:
                continue
            shrink = volume_shrinkage.get((position, stat))
            if shrink is None:
                projected[stat] = 0.0
                continue
            total = float((recent[stat].to_numpy() * weights).sum())
            projected[stat] = _shrink(total, effective_games, shrink.prior_mean, shrink.k)

        # 2. Rates per opportunity, regressed hard — this is where the model
        #    stops believing a 6.1 yards-per-carry hot streak.
        for stat, denominator in RATE_STATS:
            if stat not in recent.columns or denominator not in recent.columns:
                continue
            shrink = rate_shrinkage.get((position, f"{stat}/{denominator}"))
            if shrink is None:
                projected[stat] = 0.0
                continue

            stat_total = float((recent[stat].to_numpy() * weights).sum())
            opportunity_total = float((recent[denominator].to_numpy() * weights).sum())
            rate = _shrink(stat_total, opportunity_total, shrink.prior_mean, shrink.k)

            # 3. Recombine: projected opportunities x projected rate.
            projected[stat] = rate * projected.get(denominator, 0.0)

        line = pl.DataFrame([{**{c: 0.0 for c in frame.columns if c not in needed}, **projected}])
        expression, _ = score_expression(rules, set(line.columns))
        mean = float(line.select(expression.alias("p"))["p"][0])

        predictions.append(
            Prediction(
                player_id=str(player_id),
                mean=max(0.0, mean),
                sd=points_sd.get(position, 7.0),
            )
        )

    return predictions
