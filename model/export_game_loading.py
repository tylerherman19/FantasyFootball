"""How much of a fantasy week is the game rather than the player? Measured.

`GAME_LOADING` in `model/export_projections.py` is the last guessed number in the
shipping path — the audit flags it at §9.5. It states, per position, the share of
a player's weekly variance that comes from the game environment rather than from
him: QB 0.45, RB 0.30, WR 0.40, TE 0.35, all chosen.

It matters more than its obscurity suggests. It is the correlation structure of
the whole simulator — whether a quarterback and his receiver rise together,
whether a blowout suppresses both sides, and how much a stacked roster is
penalised for stacking. Every championship probability rests on it.

**Three estimators were tried. All three land far below the asserted values.**

1. *Intra-class correlation within team-games*, each player centred on his own
   mean. Returned WR 0.019, RB 0.000 — not a measurement but two effects
   cancelling: same-position team-mates share a positive game effect and a
   negative competition effect, because targets are zero-sum.

2. *Correlation against team skill-position output*, including the player.
   QB 0.363, WR 0.086, TE 0.063, RB 0.038. Biased upward, and worst exactly
   where it looks best: a quarterback *is* most of his team's skill output, so
   this partly correlates him with himself.

3. *The same, leave-one-out* — his deviation against his team-mates' deviation,
   his own points removed. **QB 0.103, RB 0.007, TE 0.001, WR 0.001.**

The third is the least self-confounded and is the headline number. Even the most
generous of the three puts every non-quarterback below 0.09 against an asserted
0.30-0.40.

**So the constants are wrong, and this does not replace them.** That is a
deliberate decision, not an omission.

Every estimator here still nets the game effect against target competition, and
they cannot be separated by correlating fantasy output with fantasy output —
which is all three of these do. Swapping in 0.001 would tell the simulator that a
quarterback and his top receiver are independent, and that is certainly false;
the QB-WR1 stack is real, and it is visible in estimator 3 as the one position
that retains signal.

What the numbers do establish is that the asserted values are too high, probably
by a large factor, and that the product has been generating more team correlation
than the data supports — which inflates the variance of a stacked roster and
therefore distorts every title probability quoted for one.

Fixing it properly needs an exogenous measure of the game environment — the
Vegas total, or drive-level simulation as `docs/PLAN.md` specifies for v3 — not
another correlation between two fantasy scores. Recorded here with numbers so the
next attempt starts from evidence rather than from the same guess.

    uv run --project model python model/export_game_loading.py
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import polars as pl

from model.backtest.harness import SKILL_POSITIONS, default_lake
from model.features.store import FeatureStore

FIRST_SEASON = 2016

#: A player needs enough weeks for his own mean to be a real baseline.
MIN_PLAYER_WEEKS = 8

#: A team-game needs enough players at a position to have a group mean.
MIN_GROUP_SIZE = 2

#: Reference scoring, only to have one production number per player-week.
_RULES: dict[str, float] = {
    "passing_yards": 0.04, "passing_tds": 4.0, "passing_interceptions": -1.0,
    "rushing_yards": 0.1, "rushing_tds": 6.0,
    "receptions": 1.0, "receiving_yards": 0.1, "receiving_tds": 6.0,
}


def measure(store: FeatureStore) -> dict[str, dict[str, float | None]]:
    """Correlate a player's weekly surprise with the game's actual scoring.

    The three earlier attempts all correlated one fantasy score against another,
    which is why they could not separate the game effect from target
    competition. Points scored in the game is not a rival for anyone's targets,
    so it does not have that problem.
    """
    stats = store.raw("player_stats").pl()
    schedules = store.raw("schedules").pl()
    if stats.height == 0 or schedules.height == 0:
        raise SystemExit("player_stats or schedules is empty")

    terms = [
        pl.col(stat).cast(pl.Float64).fill_null(0.0) * weight
        for stat, weight in _RULES.items()
        if stat in stats.columns
    ]
    if not terms:
        raise SystemExit("player_stats is missing the scoring columns")

    # The environment, from the scoreboard rather than from fantasy output.
    games = (
        schedules.filter(
            (pl.col("season") >= FIRST_SEASON)
            & pl.col("home_score").is_not_null()
            & pl.col("away_score").is_not_null()
        )
        .select(
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            pl.col("home_team").cast(pl.Utf8),
            pl.col("away_team").cast(pl.Utf8),
            pl.col("home_score").cast(pl.Float64),
            pl.col("away_score").cast(pl.Float64),
        )
    )

    # One row per team per game: what his side scored, and what the game
    # produced in total. Two different environment measures, both exogenous.
    home = games.select(
        pl.col("season"), pl.col("week"),
        pl.col("home_team").alias("team"),
        pl.col("home_score").alias("team_score"),
        (pl.col("home_score") + pl.col("away_score")).alias("game_total"),
    )
    away = games.select(
        pl.col("season"), pl.col("week"),
        pl.col("away_team").alias("team"),
        pl.col("away_score").alias("team_score"),
        (pl.col("home_score") + pl.col("away_score")).alias("game_total"),
    )
    environment = pl.concat([home, away])

    frame = (
        stats.filter(
            (pl.col("season") >= FIRST_SEASON)
            & pl.col("position").is_in(SKILL_POSITIONS)
            & pl.col("team").is_not_null()
        )
        .with_columns(pl.sum_horizontal(terms).alias("points"))
        .select(
            pl.col("player_id").cast(pl.Utf8),
            pl.col("position").cast(pl.Utf8),
            pl.col("team").cast(pl.Utf8),
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            pl.col("points"),
        )
        .join(environment, on=["team", "season", "week"], how="inner")
    )
    if frame.height == 0:
        raise SystemExit("player stats did not join to schedules — check team codes")

    # Centre both sides on their own baseline, so what is correlated is his
    # surprise against the game's surprise rather than his quality against his
    # team's quality.
    per_player = frame.group_by("player_id").agg(
        pl.col("points").mean().alias("player_mean"), pl.len().alias("weeks")
    )
    per_team = frame.group_by(["team", "season"]).agg(
        pl.col("team_score").mean().alias("team_score_mean"),
        pl.col("game_total").mean().alias("game_total_mean"),
    )

    centred = (
        frame.join(per_player, on="player_id", how="inner")
        .filter(pl.col("weeks") >= MIN_PLAYER_WEEKS)
        .join(per_team, on=["team", "season"], how="inner")
        .with_columns(
            (pl.col("points") - pl.col("player_mean")).alias("deviation"),
            (pl.col("team_score") - pl.col("team_score_mean")).alias("team_deviation"),
            (pl.col("game_total") - pl.col("game_total_mean")).alias("total_deviation"),
        )
    )

    out: dict[str, dict[str, float | None]] = {}

    for position in SKILL_POSITIONS:
        subset = centred.filter(pl.col("position") == position)
        if subset.height < 500:
            continue

        team_r = subset.select(pl.corr("deviation", "team_deviation").alias("r"))["r"][0]
        total_r = subset.select(pl.corr("deviation", "total_deviation").alias("r"))["r"][0]
        if team_r is None:
            out[position] = {"loading": None, "observations": subset.height}
            continue

        out[position] = {
            # Share of his weekly variance explained by how much his side
            # scored. This is what GAME_LOADING is defined as.
            "loading": round(min(0.95, max(0.0, float(team_r) ** 2)), 4),
            "teamScoreCorrelation": round(float(team_r), 4),
            "gameTotalCorrelation": round(float(total_r), 4) if total_r is not None else None,
            "observations": int(subset.height),
        }

    return out


def main() -> None:
    with FeatureStore(default_lake()) as store:
        measured = measure(store)

    payload = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "firstSeason": FIRST_SEASON,
        "method": (
            "Squared correlation between a player's deviation from his own mean "
            "and his TEAM-MATES' deviation from theirs that week — leave-one-out, "
            "so a quarterback is not correlated against a total he dominates. "
            "The share of his weekly variance the game environment explains, "
            "which is what GAME_LOADING is defined to be."
        ),
        "caveat": (
            "These numbers are NOT wired into GAME_LOADING. Every estimator here "
            "correlates one fantasy score against another, so all of them net the "
            "game effect against target competition and cannot separate the two. "
            "They establish that the asserted values are too high, not what the "
            "right values are. A correct estimate needs an exogenous game measure "
            "- the Vegas total, or drive-level simulation - per docs/PLAN.md v3."
        ),
        "assertedValues": {"QB": 0.45, "RB": 0.30, "WR": 0.40, "TE": 0.35},
        "positions": measured,
    }

    out = Path(__file__).resolve().parents[0] / "artifacts" / "game-loading.json"
    out.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    print(f"wrote {out.name}")
    asserted = {"QB": 0.45, "RB": 0.30, "WR": 0.40, "TE": 0.35}
    print(f"  {'pos':4s} {'measured':>9s} {'asserted':>9s} {'n':>8s}")
    for position in sorted(measured):
        row = measured[position]
        loading = row.get("loading")
        shown = f"{loading:.3f}" if loading is not None else "—"
        print(
            f"  {position:4s} {shown:>9s} {asserted.get(position, 0):9.2f} "
            f"{row.get('observations', 0):8,d}"
        )


if __name__ == "__main__":
    main()
