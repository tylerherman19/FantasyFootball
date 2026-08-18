"""Projections for kickers, team defenses and individual defensive players.

The skill-position model decomposes into opportunity x efficiency because
volume and efficiency have very different persistence. These groups don't work
that way — there is no "target share" for a kicker — so they are modelled as
per-game volumes directly, with the same empirical-Bayes shrinkage estimating
how much to trust a player's own history versus the positional baseline.

The shrinkage constants matter more here than anywhere, because these positions
are mostly noise:

- Kicker output is driven by how often his offense stalls in field goal range,
  which is a property of the team, not the kicker. A 60-yard leg matters far
  less than most managers believe.
- Team defense fantasy scoring is dominated by touchdowns and turnovers, both
  close to random week to week.
- IDP tackle volume, by contrast, is genuinely sticky — a linebacker who plays
  every snap keeps making tackles — which is why IDP leagues reward projecting
  it properly rather than guessing.

The estimator discovers all three facts from the data rather than being told.
"""

from __future__ import annotations

import numpy as np
import polars as pl

from model.backtest.harness import Prediction
from model.features.scoring import PTS_ALLOW_TIERS, score_expression
from model.features.store import AsOf, FeatureStore

#: Weekly stat columns per position group. Everything the scoring engine can
#: consume for these positions, so no league's rules go silently unscored.
KICKING_STATS: tuple[str, ...] = (
    "fg_made_0_19", "fg_made_20_29", "fg_made_30_39",
    "fg_made_40_49", "fg_made_50_59", "fg_made_60_",
    "fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39",
    "fg_missed_40_49", "fg_missed_50_59", "fg_missed_60_",
    "fg_made", "fg_missed", "pat_made", "pat_missed",
)

IDP_STATS: tuple[str, ...] = (
    "def_tackles_solo", "def_tackle_assists", "def_tackles_for_loss",
    "def_sacks", "def_sack_yards", "def_qb_hits",
    "def_interceptions", "def_pass_defended",
    "def_fumbles_forced", "def_fumbles", "def_tds", "def_safeties",
)

TEAM_DEFENSE_STATS: tuple[str, ...] = (
    "def_sacks", "def_interceptions", "def_fumbles", "def_fumbles_forced",
    "def_tds", "def_safeties", "def_pat_blocks", "def_fg_blocks",
)

LOOKBACK_GAMES = 24
HALF_LIFE_GAMES = 10.0
MIN_K = 1.0


def _weights(n: int) -> np.ndarray:
    return 0.5 ** (np.arange(n - 1, -1, -1, dtype=float) / HALF_LIFE_GAMES)


def _shrinkage_constants(frame: pl.DataFrame, stats: tuple[str, ...]) -> dict[str, tuple[float, float]]:
    """stat -> (prior mean, k), estimated the same way as the skill model.

    k = within-player variance / between-player variance: the number of games at
    which a player is half regressed toward the positional mean.
    """
    constants: dict[str, tuple[float, float]] = {}

    for stat in stats:
        if stat not in frame.columns:
            continue

        per_player = frame.group_by("player_id").agg(
            pl.col(stat).mean().alias("player_mean"),
            pl.col(stat).var().alias("player_var"),
            pl.len().alias("games"),
        )
        established = per_player.filter(pl.col("games") >= 4).drop_nulls("player_var")

        prior_mean = float(frame[stat].mean() or 0.0)

        if established.height < 8:
            constants[stat] = (prior_mean, 10.0)
            continue

        within = float(established["player_var"].mean() or 0.0)
        between = float(established["player_mean"].var() or 0.0)
        mean_games = float(established["games"].mean() or 1.0)

        # Between-player variance is inflated by sampling noise; remove the
        # expected contribution so k isn't systematically understated.
        between_true = max(between - within / mean_games, 1e-9)
        k = max(MIN_K, within / between_true) if within > 0 else MIN_K

        constants[stat] = (prior_mean, float(min(k, 500.0)))

    return constants


def _project(
    frame: pl.DataFrame,
    stats: tuple[str, ...],
    rules: dict[str, float],
    id_column: str = "player_id",
) -> list[Prediction]:
    """Shrink each stat toward its positional mean, then score the line."""
    available = [s for s in stats if s in frame.columns]
    if not available or frame.height == 0:
        return []

    constants = _shrinkage_constants(frame, tuple(available))
    score, _ = score_expression(rules, set(frame.columns))
    scored = frame.with_columns(score.alias("points"))
    residual_sd = float(scored["points"].std() or 4.0)

    predictions: list[Prediction] = []

    for (entity_id,), group in frame.group_by([id_column], maintain_order=True):
        recent = group.tail(LOOKBACK_GAMES)
        if recent.height == 0:
            continue

        weights = _weights(recent.height)
        effective_games = float(weights.sum())

        line: dict[str, float] = {}
        for stat in available:
            prior_mean, k = constants[stat]
            total = float((recent[stat].to_numpy() * weights).sum())
            line[stat] = (total + prior_mean * k) / (effective_games + k)

        row = pl.DataFrame([{**{c: 0.0 for c in frame.columns if c not in (id_column,)}, **line}])
        expression, _ = score_expression(rules, set(row.columns))
        mean = float(row.select(expression.alias("p"))["p"][0])

        predictions.append(
            Prediction(player_id=str(entity_id), mean=max(0.0, mean), sd=residual_sd)
        )

    return predictions


def _stat_lines(
    frame: pl.DataFrame,
    stats: tuple[str, ...],
    id_column: str = "player_id",
) -> dict[str, dict[str, float]]:
    """Shrunk per-game stat lines, unscored — the league applies its own rules."""
    available = [s for s in stats if s in frame.columns]
    if not available or frame.height == 0:
        return {}

    constants = _shrinkage_constants(frame, tuple(available))
    out: dict[str, dict[str, float]] = {}

    for (entity_id,), group in frame.group_by([id_column], maintain_order=True):
        recent = group.tail(LOOKBACK_GAMES)
        if recent.height == 0:
            continue

        weights = _weights(recent.height)
        effective_games = float(weights.sum())

        line: dict[str, float] = {}
        for stat in available:
            prior_mean, k = constants[stat]
            total = float((recent[stat].to_numpy() * weights).sum())
            line[stat] = (total + prior_mean * k) / (effective_games + k)

        out[str(entity_id)] = line

    return out


def kicker_stat_lines(store: FeatureStore, as_of: AsOf) -> dict[str, dict[str, float]]:
    history = store.as_of("player_stats", as_of, seasons_back=3).pl()
    if history.height == 0:
        return {}
    frame = history.filter(pl.col("position") == "K").select(
        pl.col("player_id").cast(pl.Utf8),
        *[pl.col(c).cast(pl.Float64).fill_null(0.0) for c in KICKING_STATS if c in history.columns],
    )
    return _stat_lines(frame, KICKING_STATS)


def idp_stat_lines(store: FeatureStore, as_of: AsOf) -> dict[str, dict[str, float]]:
    history = store.as_of("player_stats", as_of, seasons_back=3).pl()
    if history.height == 0:
        return {}
    idp_positions = ["DL", "LB", "DB", "DE", "DT", "NT", "CB", "S", "SAF", "OLB", "ILB", "MLB"]
    frame = history.filter(pl.col("position").is_in(idp_positions)).select(
        pl.col("player_id").cast(pl.Utf8),
        *[pl.col(c).cast(pl.Float64).fill_null(0.0) for c in IDP_STATS if c in history.columns],
    )
    return _stat_lines(frame, IDP_STATS)


def team_defense_stat_lines(store: FeatureStore, as_of: AsOf) -> dict[str, dict[str, float]]:
    """Team defense lines, plus expected points allowed as its own field.

    Points allowed is the largest component of team-defense scoring and cannot
    come from the defense's own stat line — it is the opponent's score. It is
    carried through as `_points_allowed` so each league can apply its own tier
    table rather than inheriting ours.
    """
    history = store.as_of("team_stats", as_of, seasons_back=3).pl()
    if history.height == 0 or "team" not in history.columns:
        return {}

    frame = history.select(
        pl.col("team").cast(pl.Utf8).alias("player_id"),
        *[pl.col(c).cast(pl.Float64).fill_null(0.0) for c in TEAM_DEFENSE_STATS if c in history.columns],
    )
    lines = _stat_lines(frame, TEAM_DEFENSE_STATS)

    for team, allowed in _expected_points_allowed(store, as_of).items():
        if team in lines:
            lines[team]["_points_allowed"] = allowed

    return lines


def _expected_points_allowed(store: FeatureStore, as_of: AsOf) -> dict[str, float]:
    """Points a defense is expected to concede, shrunk toward the league mean."""
    games = store.as_of("schedules", as_of, seasons_back=2).pl()
    if games.height == 0:
        return {}

    rows: list[dict[str, object]] = []
    for game in games.iter_rows(named=True):
        home, away = game.get("home_team"), game.get("away_team")
        home_score, away_score = game.get("home_score"), game.get("away_score")
        if home is None or away is None or home_score is None or away_score is None:
            continue
        rows.append({"team": str(home), "allowed": float(away_score)})
        rows.append({"team": str(away), "allowed": float(home_score)})

    if not rows:
        return {}

    frame = pl.DataFrame(rows)
    league_mean = float(frame["allowed"].mean() or 21.0)
    SHRINK_GAMES = 8.0

    out: dict[str, float] = {}
    for (team,), group in frame.group_by(["team"], maintain_order=True):
        n = float(group.height)
        out[str(team)] = (float(group["allowed"].sum()) + league_mean * SHRINK_GAMES) / (n + SHRINK_GAMES)

    return out


def build_kickers(store: FeatureStore, as_of: AsOf, rules: dict[str, float]) -> list[Prediction]:
    history = store.as_of("player_stats", as_of, seasons_back=3).pl()
    if history.height == 0:
        return []

    frame = history.filter(pl.col("position") == "K").select(
        pl.col("player_id").cast(pl.Utf8),
        *[pl.col(c).cast(pl.Float64).fill_null(0.0) for c in KICKING_STATS if c in history.columns],
    )
    return _project(frame, KICKING_STATS, rules)


def build_idp(store: FeatureStore, as_of: AsOf, rules: dict[str, float]) -> list[Prediction]:
    history = store.as_of("player_stats", as_of, seasons_back=3).pl()
    if history.height == 0:
        return []

    # nflverse uses granular defensive positions; fantasy platforms bucket them.
    idp_positions = ["DL", "LB", "DB", "DE", "DT", "NT", "CB", "S", "SAF", "OLB", "ILB", "MLB"]

    frame = history.filter(pl.col("position").is_in(idp_positions)).select(
        pl.col("player_id").cast(pl.Utf8),
        *[pl.col(c).cast(pl.Float64).fill_null(0.0) for c in IDP_STATS if c in history.columns],
    )
    return _project(frame, IDP_STATS, rules)


def build_team_defense(store: FeatureStore, as_of: AsOf, rules: dict[str, float]) -> list[Prediction]:
    """Team defenses, keyed by team abbreviation — which is how Sleeper ids them."""
    history = store.as_of("team_stats", as_of, seasons_back=3).pl()
    if history.height == 0 or "team" not in history.columns:
        return []

    frame = history.select(
        pl.col("team").cast(pl.Utf8).alias("player_id"),
        *[pl.col(c).cast(pl.Float64).fill_null(0.0) for c in TEAM_DEFENSE_STATS if c in history.columns],
    )

    predictions = _project(frame, TEAM_DEFENSE_STATS, rules)

    # Points allowed is the largest single component of team-defense scoring and
    # cannot come from the defense's own stat line — it is the opponent's score.
    # Added separately, using each defense's recent scoring allowed.
    allowed = _points_allowed_scores(store, as_of, rules)

    return [
        Prediction(
            player_id=p.player_id,
            mean=p.mean + allowed.get(p.player_id, 0.0),
            sd=p.sd,
        )
        for p in predictions
    ]


def _points_allowed_scores(store: FeatureStore, as_of: AsOf, rules: dict[str, float]) -> dict[str, float]:
    """Expected points from the points-allowed tier, per team.

    Uses the team's recent points allowed, shrunk toward the league mean, then
    reads the league's own tier table. A defense that has allowed 14 a game is
    worth several points a week more than one allowing 27, and no counting stat
    captures that.
    """
    tiers = [(key, low, high) for key, low, high in PTS_ALLOW_TIERS if rules.get(key, 0) != 0]
    if not tiers:
        return {}

    games = store.as_of("schedules", as_of, seasons_back=2).pl()
    if games.height == 0:
        return {}

    rows: list[dict[str, object]] = []
    for game in games.iter_rows(named=True):
        home, away = game.get("home_team"), game.get("away_team")
        home_score, away_score = game.get("home_score"), game.get("away_score")
        if home is None or away is None or home_score is None or away_score is None:
            continue
        rows.append({"team": str(home), "allowed": float(away_score)})
        rows.append({"team": str(away), "allowed": float(home_score)})

    if not rows:
        return {}

    frame = pl.DataFrame(rows)
    league_mean = float(frame["allowed"].mean() or 21.0)

    # Shrink toward the league mean: a defense with four games of history should
    # not be projected on four games of history alone.
    SHRINK_GAMES = 8.0

    out: dict[str, float] = {}
    for (team,), group in frame.group_by(["team"], maintain_order=True):
        n = float(group.height)
        expected_allowed = (float(group["allowed"].sum()) + league_mean * SHRINK_GAMES) / (n + SHRINK_GAMES)

        for key, low, high in tiers:
            if low <= expected_allowed <= high:
                out[str(team)] = float(rules[key])
                break

    return out
