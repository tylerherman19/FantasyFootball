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
    stats = store.raw("player_stats").pl()
    if stats.height == 0:
        raise SystemExit("player_stats is empty")

    terms = [
        pl.col(stat).cast(pl.Float64).fill_null(0.0) * weight
        for stat, weight in _RULES.items()
        if stat in stats.columns
    ]
    if not terms:
        raise SystemExit("player_stats is missing the scoring columns")

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
    )

    # The game environment: total skill-position output by this team that week.
    team_games = frame.group_by(["team", "season", "week"]).agg(
        pl.col("points").sum().alias("team_points")
    )

    # Centre each player on himself, so his quality is removed and only his
    # weekly surprise remains.
    per_player = frame.group_by("player_id").agg(
        pl.col("points").mean().alias("player_mean"), pl.len().alias("weeks")
    )

    centred = (
        frame.join(per_player, on="player_id", how="inner")
        .filter(pl.col("weeks") >= MIN_PLAYER_WEEKS)
        .join(team_games, on=["team", "season", "week"], how="inner")
        .with_columns(
            (pl.col("points") - pl.col("player_mean")).alias("deviation"),
            # Leave-one-out. The team total includes the player, and a
            # quarterback *is* most of his team's skill output — correlating him
            # against a total he dominates measures him against himself and
            # inflates his loading. Removing his own points is the difference
            # between a measurement and a tautology.
            (pl.col("team_points") - pl.col("points")).alias("others_points"),
        )
    )

    others_baseline = centred.group_by("player_id").agg(
        pl.col("others_points").mean().alias("others_mean")
    )
    centred = centred.join(others_baseline, on="player_id", how="inner").with_columns(
        (pl.col("others_points") - pl.col("others_mean")).alias("team_deviation")
    )

    out: dict[str, dict[str, float | None]] = {}

    for position in SKILL_POSITIONS:
        subset = centred.filter(pl.col("position") == position)
        if subset.height < 500:
            continue

        correlation = subset.select(
            pl.corr("deviation", "team_deviation").alias("r")
        )["r"][0]
        if correlation is None:
            out[position] = {"loading": None, "observations": subset.height}
            continue

        # Squared correlation is the share of variance explained, which is the
        # quantity GAME_LOADING is defined as.
        loading = float(correlation) ** 2

        out[position] = {
            "loading": round(min(0.95, max(0.0, loading)), 4),
            "correlation": round(float(correlation), 4),
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
