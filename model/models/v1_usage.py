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

import json
from dataclasses import dataclass
from collections.abc import Mapping
from pathlib import Path

import numpy as np
import polars as pl

from model.backtest.harness import SKILL_POSITIONS, Prediction
from model.features.scoring import score_expression
from model.features.store import AsOf, FeatureStore
from model.features.team_context import team_tendencies

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

#: Measured spread corrections, per position.
#:
#: The naive spread — how much scores vary across all players at a position — is
#: far too wide for a single player's week, because it includes the gap between a
#: star and a backup. Calibration measured the real forecast error and produced
#: these multipliers; without them the model is under-confident, its 80%
#: intervals capture 90% of outcomes, and every probability built on top is
#: blurred. Regenerate with model/backtest/run_calibration.py.
_CALIBRATION_PATH = Path(__file__).resolve().parents[1] / "artifacts" / "spread-calibration.json"


def _spread_multipliers() -> dict[str, float]:
    try:
        payload = json.loads(_CALIBRATION_PATH.read_text(encoding="utf-8"))
        return {str(k): float(v) for k, v in payload.get("multipliers", {}).items()}
    except (OSError, ValueError):
        # No calibration file yet: ship uncorrected rather than guessing.
        return {}


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


@dataclass(frozen=True)
class Explanation:
    """Why a projection is what it is, in the model's own terms.

    Fantasy points here are an identity — `Σ(opportunity × rate × weight)` — and
    the model already computes each half separately, then discards the parts and
    keeps the product. That is the whole explanation, thrown away at the last
    step.

    So three stat lines are kept rather than one:

    - `prior` — every stat at its positional average. What the model would say
      about a player it knew nothing about beyond his position.
    - `opportunity` — the player's own projected volume, but still the
      positional average *rates*. The gap from `prior` is what his usage is
      worth.
    - `final` — his volume and his rates. The gap from `opportunity` is what his
      efficiency is worth.

    Scored per league at serve time, exactly like the projection itself, so the
    decomposition is in the same currency as the number it explains. A waterfall
    built from these three is arithmetic, not narration — which is the
    difference between an explanation and a plausible story told afterwards.

    `effective_games` is the recency-weighted sample behind it all: the honest
    answer to "how much does the model actually know about this man?"
    """

    position: str
    prior: dict[str, float]
    #: Player volume before the offensive-context adjustment.
    base_opportunity: dict[str, float]
    opportunity: dict[str, float]
    final: dict[str, float]
    #: Recency-weighted games observed. Drives the confidence read.
    effective_games: float
    #: Raw per-game volume, unshrunk — what he has actually been doing lately.
    observed: dict[str, float]
    #: Bounded offensive scheme multipliers that changed the opportunity line.
    scheme: dict[str, float | str]


def _scheme_context(
    store: FeatureStore,
    as_of: AsOf,
) -> dict[str, dict[str, float]]:
    """Return conservative offensive-context multipliers by team.

    Pace and neutral pass identity are upstream opportunity features. They are
    deliberately bounded to six percent so scheme can improve role allocation
    without overpowering player history or double-counting a defensive matchup.
    """
    try:
        tendencies = team_tendencies(store, as_of, seasons_back=1)
    except Exception:
        # Scheme is an enhancement, not a reason to lose the entire weekly
        # artifact when a play-by-play feed is absent or its schema drifts.
        # The player-level usage model remains the safe fallback.
        return {}
    latest: dict[str, object] = {}
    for tendency in sorted(tendencies, key=lambda item: item.season):
        latest[str(tendency.team)] = tendency
    if not latest:
        return {}

    mean_plays = sum(t.plays_per_game for t in latest.values()) / len(latest)
    mean_neutral_pass = sum(t.neutral_pass_rate for t in latest.values()) / len(latest)
    mean_proe = sum(t.proe for t in latest.values()) / len(latest)

    out: dict[str, dict[str, float]] = {}
    for team, tendency in latest.items():
        pace = float(np.clip(tendency.plays_per_game / max(mean_plays, 1.0), 0.94, 1.06))
        pass_shape = float(
            np.clip(
                1.0
                + 1.25 * (tendency.neutral_pass_rate - mean_neutral_pass)
                + 0.50 * (tendency.proe - mean_proe),
                0.94,
                1.06,
            )
        )
        run_shape = float(
            np.clip(
                1.0
                - 1.25 * (tendency.neutral_pass_rate - mean_neutral_pass)
                - 0.50 * (tendency.proe - mean_proe),
                0.94,
                1.06,
            )
        )
        out[team] = {
            "attempts": pace * pass_shape,
            "targets": pace * pass_shape,
            "carries": pace * run_shape,
            "pace": pace,
            "passShape": pass_shape,
            "runShape": run_shape,
        }
    return out


def project_stat_lines(store: FeatureStore, as_of: AsOf) -> dict[str, dict[str, float]]:
    """Projected stat lines, deliberately unscored.

    Scoring is not applied here. Every league scores differently — 42, 64 and 132
    distinct keys across Tyler's three leagues — so the model projects what a
    player will *do*, and each league converts that to points under its own
    rules. Baking one scoring system into the artifact would silently hand two of
    the three leagues the wrong numbers.
    """
    return project_with_explanations(store, as_of)[0]


def project_with_explanations(
    store: FeatureStore,
    as_of: AsOf,
    team_by_player: Mapping[str, str] | None = None,
) -> tuple[dict[str, dict[str, float]], dict[str, Explanation]]:
    """The projection, plus the decomposition that produced it.

    Kept as one pass rather than two so the explanation cannot drift from the
    number it explains — a `Why?` panel computed by a second code path is a
    second model, and the first time they disagree the product is lying.
    """
    history = store.as_of("player_stats", as_of, seasons_back=3).pl()
    if history.height == 0:
        return {}, {}

    columns = [
        c
        for c in {*VOLUME_STATS, *(s for s, _ in RATE_STATS), *(d for _, d in RATE_STATS)}
        if c in history.columns
    ]
    if "team" in history.columns:
        columns.append("team")

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
    if frame.height == 0:
        return {}, {}

    # Re-estimated at every as-of, from data available then. Freezing the
    # constants would leak the future into early-season weeks.
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

    out: dict[str, dict[str, float]] = {}
    explained: dict[str, Explanation] = {}
    scheme_by_team = _scheme_context(store, as_of)

    for (player_id,), group in frame.group_by(["player_id"], maintain_order=True):
        recent = group.tail(LOOKBACK_GAMES)
        if recent.height == 0:
            continue

        position = str(recent["position"][-1])
        weights = _weights(recent.height)
        effective_games = float(weights.sum())

        line: dict[str, float] = {}
        # Same arithmetic, with the player's contribution removed one half at a
        # time. `prior` knows only his position; `opportunity` adds his volume
        # and stops there.
        prior: dict[str, float] = {}
        opportunity: dict[str, float] = {}
        observed: dict[str, float] = {}

        # Volume per game, lightly regressed — this is the sticky part.
        for stat in VOLUME_STATS:
            if stat not in recent.columns:
                continue
            shrink = volume_shrinkage.get((position, stat))
            if shrink is None:
                line[stat] = prior[stat] = opportunity[stat] = 0.0
                continue
            total = float((recent[stat].to_numpy() * weights).sum())
            line[stat] = _shrink(total, effective_games, shrink.prior_mean, shrink.k)
            opportunity[stat] = line[stat]
            prior[stat] = shrink.prior_mean
            observed[stat] = total / effective_games if effective_games > 0 else 0.0

        # Rates per opportunity, regressed hard — this is where the model stops
        # believing a six-yards-per-carry hot streak.
        for stat, denominator in RATE_STATS:
            if stat not in recent.columns or denominator not in recent.columns:
                continue
            shrink = rate_shrinkage.get((position, f"{stat}/{denominator}"))
            if shrink is None:
                line[stat] = prior[stat] = opportunity[stat] = 0.0
                continue

            stat_total = float((recent[stat].to_numpy() * weights).sum())
            opportunity_total = float((recent[denominator].to_numpy() * weights).sum())
            rate = _shrink(stat_total, opportunity_total, shrink.prior_mean, shrink.k)

            line[stat] = rate * line.get(denominator, 0.0)
            # His volume, the position's rate.
            opportunity[stat] = shrink.prior_mean * opportunity.get(denominator, 0.0)
            # The position's volume and the position's rate.
            prior[stat] = shrink.prior_mean * prior.get(denominator, 0.0)
            if opportunity_total > 0:
                observed[stat] = stat_total / opportunity_total

        # Offensive identity is applied after the player-level usage/rate
        # estimate. This keeps the model's most stable evidence (the player's
        # own role) intact while accounting for the environment that supplies
        # the opportunities. Every dependent stat uses the same denominator
        # multiplier, so a team cannot create yards without also creating the
        # attempts/carries/targets that produce them.
        historical_teams = []
        if "team" in recent.columns:
            historical_teams = [
                str(value)
                for value in recent["team"].to_list()
                if value is not None and str(value) != ""
            ]
        team = (
            str(team_by_player.get(str(player_id)))
            if team_by_player is not None and team_by_player.get(str(player_id))
            else (historical_teams[-1] if historical_teams else "")
        )
        scheme = scheme_by_team.get(team)
        base_opportunity = dict(opportunity)
        scheme_explanation: dict[str, float | str] = {"team": team}
        if scheme is not None and position in SKILL_POSITIONS:
            for volume in VOLUME_STATS:
                factor = scheme[volume]
                if volume in line:
                    line[volume] *= factor
                    opportunity[volume] = line[volume]
                for stat, denominator in RATE_STATS:
                    if denominator == volume and stat in line:
                        line[stat] *= factor
                        opportunity[stat] = opportunity.get(stat, 0.0) * factor
            scheme_explanation.update(
                {
                    "paceMultiplier": scheme["pace"],
                    "passShape": scheme["passShape"],
                    "runShape": scheme["runShape"],
                }
            )
        else:
            scheme_explanation.update({"paceMultiplier": 1.0, "passShape": 1.0, "runShape": 1.0})

        line["_position"] = 0.0  # placeholder keeps the dict homogeneous
        clean = {k: v for k, v in line.items() if not k.startswith("_")}
        out[str(player_id)] = clean
        explained[str(player_id)] = Explanation(
            position=position,
            prior={k: round(v, 4) for k, v in prior.items()},
            base_opportunity={k: round(v, 4) for k, v in base_opportunity.items()},
            opportunity={k: round(v, 4) for k, v in opportunity.items()},
            final=clean,
            effective_games=round(effective_games, 2),
            observed={k: round(v, 4) for k, v in observed.items()},
            scheme=scheme_explanation,
        )

    return out, explained


def build(
    store: FeatureStore,
    as_of: AsOf,
    rules: dict[str, float],
    spread_multipliers: dict[str, float] | None = None,
) -> list[Prediction]:
    """Project stat lines, then score them under `rules`.

    Kept as the harness entry point so the backtest scores exactly what the app
    serves — same lines, same scoring path, no second implementation to drift.
    """
    lines = project_stat_lines(store, as_of)
    if not lines:
        return []

    history = store.as_of("player_stats", as_of, seasons_back=3).pl()
    frame = history.filter(pl.col("position").is_in(SKILL_POSITIONS))

    score, _ = score_expression(rules, set(frame.columns))
    scored = frame.with_columns(score.alias("points"))
    points_sd = {
        row["position"]: float(row["sd"] or 7.0)
        for row in scored.group_by("position").agg(pl.col("points").std().alias("sd")).to_dicts()
    }
    position_of = {
        str(row["player_id"]): str(row["position"])
        for row in frame.select(["player_id", "position"]).unique(subset=["player_id"]).to_dicts()
    }

    multipliers = _spread_multipliers() if spread_multipliers is None else spread_multipliers
    predictions: list[Prediction] = []

    for player_id, line in lines.items():
        row = pl.DataFrame([line])
        expression, _ = score_expression(rules, set(row.columns))
        mean = float(row.select(expression.alias("p"))["p"][0])

        position = position_of.get(player_id, "")
        sd = points_sd.get(position, 7.0) * multipliers.get(position, 1.0)

        predictions.append(
            Prediction(player_id=player_id, mean=max(0.0, mean), sd=sd)
        )

    return predictions
