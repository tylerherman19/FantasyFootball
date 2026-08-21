"""Projections for players who have never taken an NFL snap.

v1 rebuilds a stat line from a player's own history, shrunk toward his position.
A rookie has no history, so the group never forms and **no row is emitted at
all** — not a small projection, an absent one. The consequence is not cosmetic:
the 1.01 pick sits on a dynasty roster as a name with no value, no rank, no
dynasty curve and no trade price, in the league type where rookie valuation is
most of the game.

The fix is the missing half of the empirical-Bayes statement v1 already makes.
`_shrink(total, n, prior_mean, k)` with `n = 0` returns `prior_mean` exactly.
v1's prior is the positional average, which is wrong for a rookie in both
directions — it flatters a seventh-rounder and badly undersells the first pick
of the draft. What a rookie needs is a *better prior*, not a different model, and
the thing that carries most of the information about an unplayed career is what
the NFL paid to acquire it.

So: fit expected rookie-year opportunity against draft slot on ten completed
classes, and use that curve as the prior. Once real games arrive, v1 takes over
on its own — the observations accumulate, `n` grows past `k`, and the draft-slot
prior fades out with no switch to throw.

Three inputs, all already in the lake:

- **Draft capital** — `draft_picks`, the dominant signal. Round and overall pick.
- **Depth chart position** — `depth_charts`, which separates the rookie who won
  the job in camp from the one who did not.
- **Position** — rates come from the rookie population, not the whole league,
  because rookies are less efficient than the veterans they are pooled with.

Undrafted players are not excluded. They are given the curve's value at the pick
after the last one, which is what "undrafted" actually means.

**It clears the gate.** Nothing here ships on the strength of sounding sensible.
Walk-forward over the 2024 and 2025 classes, 1,676 rookie player-weeks
(`model/backtest/run_rookie_gate.py`):

    replacement    MAE 6.255   RMSE 9.459   CRPS 5.079
    flat-rookie    MAE 5.443   RMSE 6.884   CRPS 3.787
    draft-prior    MAE 4.535   RMSE 6.189   CRPS 3.390

    draft-prior vs flat-rookie: MAE skill +16.67%

`replacement` is what the application actually did — no row, which reads as
zero. `flat-rookie` is the real baseline: the same players, the same spread, the
same scoring, with only the draft slot and depth chart removed. Beating it by
16.7% is the finding, and CRPS falling alongside MAE means the distribution
improved too rather than the mean being sharpened at the cost of calibration.

For scale, v1 scores MAE 4.568 on veteran player-weeks. A rookie with no NFL
snaps is now projected about as accurately as a veteran with years of them —
which says less about this model than about how much of a fantasy week is
decided by opportunity, and how much of a rookie's opportunity the NFL reveals
on draft night.

Two honest limits. The window is two classes, because `weekly_rosters` only
covers 2024 onward in the lake and the rookie universe is built from rosters;
this should be re-run as the lake deepens. And the evaluation is restricted to
rookies who recorded a stat line, so it measures the projection given that a
player appeared, not the probability he appears at all.

**An identity trap worth recording.** nflverse populates `draft_picks.gsis_id`
with a real gsis id (`00-0041562`) for completed classes and a PFR-style id
(`MEN516487`) for the class that just happened — 0 of 257 rows for 2026 carry a
real gsis. Joining the current class on that column silently yields nothing,
which is one of the reasons rookies vanished quietly rather than loudly. Training
therefore joins on gsis (correct for 2016-2025) while inference joins the current
class to `weekly_rosters` by normalized name, taking gsis from the roster, which
is the only place it exists before a player has played.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import polars as pl

from model.backtest.harness import SKILL_POSITIONS
from model.features.store import AsOf, FeatureStore
from model.models.v1_usage import RATE_STATS, VOLUME_STATS

#: Completed draft classes to fit the curve on. Ten is enough for a stable slope
#: per position and recent enough that the rookie usage regime is comparable.
TRAINING_SEASONS = 10

#: Picks in a modern draft. An undrafted player is priced one slot past the end
#: rather than given a separate hand-set number.
DRAFT_SIZE = 257

#: A curve needs enough rookies at a position to mean anything. Below this the
#: position falls back to a flat rookie mean, which is honest about knowing
#: nothing about the slope rather than fitting one to six points.
MIN_ROOKIES_FOR_CURVE = 40


def normalize_name(name: str) -> str:
    """Loose join key: lowercase, no punctuation, no generational suffix.

    Matches the convention in `model/ingest/crosswalk.py` so the two name joins
    in this repository agree with each other.
    """
    text = name.lower().replace(".", "").replace("'", "").replace("-", " ").strip()
    for suffix in (" jr", " sr", " ii", " iii", " iv", " v"):
        if text.endswith(suffix):
            text = text[: -len(suffix)]
    return " ".join(text.split())


@dataclass(frozen=True)
class DraftCurve:
    """Expected rookie-year per-game volume as a function of draft slot.

    Fitted as `log1p(volume) ~ a + b * log(pick)`, which is a straight line in
    the space where draft value actually behaves: the gap between pick 1 and
    pick 10 is enormous, the gap between 200 and 210 is nothing. A raw-pick
    linear fit gets that backwards at both ends.
    """

    position: str
    stat: str
    intercept: float
    slope: float
    #: Flat rookie mean, used when the slope could not be fitted and as the
    #: value the curve is blended toward for positions with thin samples.
    fallback: float
    #: Ceiling: what rookies taken in the top ten actually averaged, per game.
    #:
    #: The fit is dominated by the hundreds of late-round picks that make up most
    #: of a draft class, so extrapolating it back to pick 1 — where the data is
    #: thinnest — runs away badly. Uncapped, the curve claimed 64 carries a game
    #: for a first-overall running back.
    #:
    #: The first cap tried was the all-time rookie maximum, and it was the wrong
    #: quantity: it put a top-five pick's *prior* at the best rookie season ever
    #: recorded (21.5 carries a game), which is a forecast no one should make
    #: before a snap. Elite draft capital has an empirical answer that needs no
    #: extrapolation at all — over ten classes, backs drafted in the top ten
    #: averaged 15.7 carries and receivers 6.6 targets. That average is the
    #: expectation for a premium pick, so that is the ceiling.
    ceiling: float
    n: int
    r2: float

    def predict(self, pick: int) -> float:
        if self.slope == 0.0 and self.intercept == 0.0:
            return min(self.fallback, self.ceiling) if self.ceiling > 0 else self.fallback
        value = math.expm1(self.intercept + self.slope * math.log(max(1, pick)))
        value = max(0.0, value)
        return min(value, self.ceiling) if self.ceiling > 0 else value


#: Draft slots treated as premium, in order of preference. A position with too
#: few top-ten rookies over the window widens to round one before giving up.
_PREMIUM_TIERS: tuple[tuple[int, int], ...] = ((10, 5), (32, 8), (64, 12))


def _premium_pick_mean(picks: np.ndarray, values: np.ndarray) -> float:
    """What rookies with premium draft capital actually averaged.

    Used as the curve's ceiling. Falls back through progressively wider tiers so
    a thin position still gets a data-derived number.

    The last resort is the mean of the earliest-drafted quartile, never the
    observed maximum. Falling back to the maximum would reintroduce exactly the
    problem the ceiling exists to prevent — a prior sitting at the best rookie
    season on record — in precisely the thin-sample case where that claim is
    least defensible.
    """
    if not picks.size:
        return 0.0

    for cutoff, minimum in _PREMIUM_TIERS:
        selected = values[picks <= cutoff]
        if selected.size >= minimum:
            return float(selected.mean())

    take = max(1, math.ceil(picks.size * 0.25))
    earliest = np.argsort(picks)[:take]
    return float(values[earliest].mean())


def _fit_curve(position: str, stat: str, picks: np.ndarray, values: np.ndarray) -> DraftCurve:
    """Least squares in log-log space, with the fit quality carried along."""
    fallback = float(values.mean()) if values.size else 0.0
    ceiling = _premium_pick_mean(picks, values)

    if picks.size < MIN_ROOKIES_FOR_CURVE:
        return DraftCurve(position, stat, 0.0, 0.0, fallback, ceiling, int(picks.size), 0.0)

    x = np.log(np.maximum(1.0, picks))
    y = np.log1p(np.maximum(0.0, values))

    design = np.vstack([np.ones_like(x), x]).T
    coefficients, *_ = np.linalg.lstsq(design, y, rcond=None)
    intercept, slope = float(coefficients[0]), float(coefficients[1])

    fitted = design @ coefficients
    residual = float(((y - fitted) ** 2).sum())
    total = float(((y - y.mean()) ** 2).sum())
    r2 = 1.0 - residual / total if total > 0 else 0.0

    # A curve that slopes the wrong way is noise, not a finding: later picks
    # cannot genuinely earn more opportunity than earlier ones across a whole
    # class. Fall back rather than ship an inverted prior.
    if slope > 0:
        return DraftCurve(position, stat, 0.0, 0.0, fallback, ceiling, int(picks.size), 0.0)

    return DraftCurve(position, stat, intercept, slope, fallback, ceiling, int(picks.size), r2)


@dataclass(frozen=True)
class RookiePriors:
    """Everything needed to price a player with no NFL history."""

    #: (position, stat) -> volume curve over draft slot.
    volume: dict[tuple[str, str], DraftCurve]
    #: (position, "stat/denominator") -> rookie-population rate.
    rates: dict[tuple[str, str], float]
    #: position -> per-game fantasy-point SD among rookies. Wider than the
    #: veteran spread, because it is: a rookie's role is the least settled
    #: thing on any roster.
    spread: dict[str, float]
    #: (position, depth rank) -> multiplier on volume, measured not assumed.
    depth: dict[tuple[str, int], float]
    seasons: tuple[int, ...]


def _rookie_weeks(store: FeatureStore, as_of: AsOf) -> pl.DataFrame:
    """Every completed rookie season in the training window, one row per week.

    Joined on gsis, which is correct for classes that have finished — see the
    identity note in the module docstring for why the current class cannot use
    this path.
    """
    picks = (
        store.as_of("draft_picks", as_of, seasons_back=TRAINING_SEASONS + 2)
        .pl()
        .filter(
            (pl.col("season") < as_of.season)
            & (pl.col("season") >= as_of.season - TRAINING_SEASONS)
            & pl.col("gsis_id").is_not_null()
            & pl.col("gsis_id").str.starts_with("00-")
        )
        .select(
            pl.col("gsis_id").cast(pl.Utf8).alias("player_id"),
            pl.col("season").cast(pl.Int32).alias("draft_season"),
            pl.col("pick").cast(pl.Int32).alias("draft_pick"),
        )
        .unique(subset=["player_id"])
    )
    if picks.height == 0:
        return pl.DataFrame()

    stats = store.as_of("player_stats", as_of, seasons_back=TRAINING_SEASONS + 2).pl()
    if stats.height == 0:
        return pl.DataFrame()

    columns = [
        c
        for c in {*VOLUME_STATS, *(s for s, _ in RATE_STATS), *(d for _, d in RATE_STATS)}
        if c in stats.columns
    ]

    prepared = stats.filter(pl.col("position").is_in(SKILL_POSITIONS)).select(
        pl.col("player_id").cast(pl.Utf8),
        pl.col("position").cast(pl.Utf8),
        pl.col("season").cast(pl.Int32),
        *[pl.col(c).cast(pl.Float64).fill_null(0.0) for c in columns],
    )

    # A player's rookie year is the season he was drafted, and only that season.
    return prepared.join(picks, on="player_id", how="inner").filter(
        pl.col("season") == pl.col("draft_season")
    )


def _depth_ranks(store: FeatureStore, as_of: AsOf) -> pl.DataFrame:
    """Most recent listed depth rank per player per season.

    **Schema drift, and why this is not a one-liner.** nflverse changed the
    depth-chart format mid-stream: the 2024 and 2025 files carry `season` and
    `week` columns, the 2026 file carries an ISO `dt` timestamp and neither. The
    store unions by name, so every 2024-25 row arrives with `dt` null and every
    2026 row with `season` null. Reading either column alone silently yields an
    empty join rather than an error — which is exactly how a depth-chart
    adjustment can appear to be applied while doing nothing at all. Season is
    therefore coalesced from both.

    Depth charts are also read through `raw` rather than `as_of`, because they
    are forward-looking. A stats table is knowable only for completed weeks; a
    depth chart published on Wednesday is knowable on Sunday, and the as-of
    filter — written for performance data — discards the current season entirely.
    The filtering below restores the point-in-time guarantee on the right terms:
    prior seasons whole, and the in-flight season only up to the last snapshot
    that precedes the target week.
    """
    try:
        charts = store.raw("depth_charts").pl()
    except FileNotFoundError:
        return pl.DataFrame()
    if charts.height == 0 or "pos_rank" not in charts.columns:
        return pl.DataFrame()

    has_dt = "dt" in charts.columns
    has_season = "season" in charts.columns
    if not (has_dt or has_season):
        return pl.DataFrame()

    from_dt = (
        pl.col("dt").cast(pl.Utf8).str.slice(0, 4).cast(pl.Int32, strict=False)
        if has_dt
        else pl.lit(None, dtype=pl.Int32)
    )
    season = (
        pl.coalesce([pl.col("season").cast(pl.Int32), from_dt])
        if has_season
        else from_dt
    ).alias("_season")

    # Ordering key: the timestamp where there is one, otherwise the week.
    order = (
        pl.col("dt").cast(pl.Utf8)
        if has_dt and "week" not in charts.columns
        else pl.coalesce(
            [pl.col("dt").cast(pl.Utf8), pl.col("week").cast(pl.Utf8).str.zfill(3)]
            if has_dt and "week" in charts.columns
            else [pl.col("week").cast(pl.Utf8).str.zfill(3)]
        )
    ).alias("_order")

    prepared = (
        charts.filter(pl.col("gsis_id").is_not_null())
        .with_columns(season, order)
        .drop_nulls("_season")
        .filter(pl.col("_season") <= as_of.season)
    )

    # The in-flight season is truncated to what had been published by the target
    # week. Where only a timestamp exists it is compared against the week's
    # notional start, which is enough to keep a week-12 chart out of a week-3
    # backtest.
    if "week" in prepared.columns:
        prepared = prepared.filter(
            (pl.col("_season") < as_of.season)
            | pl.col("week").is_null()
            | (pl.col("week").cast(pl.Int32, strict=False) <= as_of.week)
        )

    if prepared.height == 0:
        return pl.DataFrame()

    return (
        prepared.sort("_order")
        .group_by(["gsis_id", "_season"])
        .agg(pl.col("pos_rank").last().alias("depth_rank"))
        .select(
            pl.col("gsis_id").cast(pl.Utf8).alias("player_id"),
            pl.col("_season").cast(pl.Int32).alias("season"),
            pl.col("depth_rank").cast(pl.Int32),
        )
        .drop_nulls("depth_rank")
    )


def _depth_multipliers(store: FeatureStore, as_of: AsOf, rookies: pl.DataFrame) -> dict[tuple[str, int], float]:
    """How much a rookie's listed depth rank moves his opportunity.

    Measured against the position's own rookie mean rather than assumed, and
    only where the lake actually carries depth charts. Where it does not, the
    result is an empty mapping and the caller applies no adjustment — which is
    the correct behaviour for a number we cannot support.
    """
    ranks = _depth_ranks(store, as_of)
    if ranks.height == 0 or rookies.height == 0:
        return {}

    # Total opportunity is the cleanest single quantity to measure depth
    # against; splitting by stat would slice an already-thin sample four ways.
    volume_columns = [c for c in VOLUME_STATS if c in rookies.columns]
    if not volume_columns:
        return {}

    joined = (
        rookies.with_columns(
            pl.sum_horizontal([pl.col(c) for c in volume_columns]).alias("_opportunity")
        )
        .join(ranks, on=["player_id", "season"], how="inner")
        .filter(pl.col("depth_rank").is_between(1, 4))
    )
    if joined.height == 0:
        return {}

    baseline = {
        str(row["position"]): float(row["_opportunity"] or 0.0)
        for row in joined.group_by("position").agg(pl.col("_opportunity").mean()).to_dicts()
    }

    raw: dict[tuple[str, int], float] = {}
    grouped = joined.group_by(["position", "depth_rank"]).agg(
        pl.col("_opportunity").mean().alias("mean"), pl.len().alias("n")
    )

    for row in grouped.to_dicts():
        position, rank, n = str(row["position"]), int(row["depth_rank"]), int(row["n"])
        base = baseline.get(position, 0.0)
        if base <= 0 or n < 15:
            continue

        ratio = float(row["mean"] or 0.0) / base
        # Shrunk toward 1.0 by sample size, on the same logic as everything else
        # here: a multiplier off twenty player-weeks should not be trusted whole.
        weight = n / (n + 40.0)
        raw[(position, rank)] = 1.0 + weight * (ratio - 1.0)

    # Depth rank is ordinal, and being listed further down a chart cannot earn a
    # player more opportunity. The unconstrained estimates violate that in the
    # thin tail — the measured RB4 multiplier came out above RB2 — which is
    # sample noise, not a discovery about fourth-string backs. A running minimum
    # down the chart is the conservative monotone fit: it never raises a deeper
    # rank above a shallower one, and it costs nothing where the data already
    # behaves.
    out: dict[tuple[str, int], float] = {}
    for position in {p for p, _ in raw}:
        running = float("inf")
        for rank in sorted(r for p, r in raw if p == position):
            running = min(running, raw[(position, rank)])
            out[(position, rank)] = running

    return out


def fit(store: FeatureStore, as_of: AsOf) -> RookiePriors:
    """Fit every rookie prior from data knowable at `as_of`."""
    rookies = _rookie_weeks(store, as_of)
    if rookies.height == 0:
        return RookiePriors({}, {}, {}, {}, ())

    per_player = rookies.group_by(["player_id", "position", "draft_pick"]).agg(
        *[pl.col(c).mean().alias(c) for c in VOLUME_STATS if c in rookies.columns],
        pl.len().alias("games"),
    )

    volume: dict[tuple[str, str], DraftCurve] = {}
    for position in SKILL_POSITIONS:
        subset = per_player.filter(pl.col("position") == position)
        if subset.height == 0:
            continue
        picks = subset["draft_pick"].to_numpy().astype(float)
        for stat in VOLUME_STATS:
            if stat not in subset.columns:
                continue
            volume[(position, stat)] = _fit_curve(
                position, stat, picks, subset[stat].to_numpy().astype(float)
            )

    # Rates come from the rookie population as a pooled ratio — total stat over
    # total opportunity — which weights by how much each player actually did
    # rather than letting a two-target week count as much as a ten-target one.
    rates: dict[tuple[str, str], float] = {}
    for position in SKILL_POSITIONS:
        subset = rookies.filter(pl.col("position") == position)
        if subset.height == 0:
            continue
        for stat, denominator in RATE_STATS:
            if stat not in subset.columns or denominator not in subset.columns:
                continue
            opportunities = float(subset[denominator].sum() or 0.0)
            if opportunities <= 0:
                continue
            rates[(position, f"{stat}/{denominator}")] = float(subset[stat].sum() or 0.0) / opportunities

    spread = _rookie_spread(rookies)
    depth = _depth_multipliers(store, as_of, rookies)
    seasons = tuple(sorted({int(s) for s in rookies["season"].to_list()}))

    return RookiePriors(volume=volume, rates=rates, spread=spread, depth=depth, seasons=seasons)


#: Reference scoring, used only to measure spread. Points are never exported —
#: each league scores the stat line itself. Mirrors `SPREAD_RULES` in
#: `model/export_projections.py` so the two spreads are on the same scale.
_SPREAD_RULES: dict[str, float] = {
    "passing_yards": 0.04, "passing_tds": 4.0, "passing_interceptions": -1.0,
    "rushing_yards": 0.1, "rushing_tds": 6.0,
    "receptions": 1.0, "receiving_yards": 0.1, "receiving_tds": 6.0,
}


def _rookie_spread(rookies: pl.DataFrame) -> dict[str, float]:
    """Week-to-week SD of rookie fantasy scoring, per position."""
    terms = [
        pl.col(stat).cast(pl.Float64).fill_null(0.0) * weight
        for stat, weight in _SPREAD_RULES.items()
        if stat in rookies.columns
    ]
    if not terms:
        return {}

    scored = rookies.with_columns(pl.sum_horizontal(terms).alias("_points"))
    return {
        str(row["position"]): float(row["sd"] or 0.0)
        for row in scored.group_by("position").agg(pl.col("_points").std().alias("sd")).to_dicts()
        if row["sd"] is not None and float(row["sd"]) > 0
    }


@dataclass(frozen=True)
class Rookie:
    """A player on an NFL roster who has not played an NFL game."""

    player_id: str
    name: str
    position: str
    team: str
    draft_pick: int
    depth_rank: int | None


def current_rosters(store: FeatureStore, as_of: AsOf) -> pl.DataFrame:
    """Weekly rosters, filtered on the terms a roster should be filtered on.

    `FeatureStore.as_of` truncates the in-flight season to *completed* weeks,
    which is right for anything measured from a game and wrong for a roster. A
    roster is a forward-looking document: the week-1 roster is published before
    week 1 kicks off, so `AsOf(2026, 1)` — whose last completed week is 0 —
    discards the entire current season and silently falls back to last year.

    That fallback is a bug in its own right, and not only for rookies: a veteran
    who changed teams in March gets his old team in the week-1 export, because
    the only rows that survived the filter are last season's. Every rookie
    disappears outright, having no prior season at all.

    So: prior seasons whole, current season up to and including the target week.
    """
    rosters = store.raw("weekly_rosters").pl()
    if rosters.height == 0 or "season" not in rosters.columns:
        return rosters

    rosters = rosters.filter(
        pl.col("season").is_between(as_of.season - 1, as_of.season)
    )
    if "week" in rosters.columns:
        rosters = rosters.filter(
            (pl.col("season") < as_of.season)
            | pl.col("week").is_null()
            | (pl.col("week").cast(pl.Int32, strict=False) <= as_of.week)
        )
    return rosters


def current_rookies(store: FeatureStore, as_of: AsOf) -> list[Rookie]:
    """The rookie class as it stands, from rosters rather than from the draft.

    Rosters are the right source: they carry a real gsis id for the current
    class where `draft_picks` does not, they include undrafted players, and they
    reflect who is actually employed in August rather than who was picked in
    April.
    """
    rosters = current_rosters(store, as_of)
    if rosters.height == 0 or "years_exp" not in rosters.columns:
        return []

    latest = (
        rosters.filter(
            (pl.col("season") == as_of.season)
            & (pl.col("years_exp") == 0)
            & pl.col("gsis_id").is_not_null()
            & pl.col("position").is_in(SKILL_POSITIONS)
        )
        .sort(["season", "week"])
        .group_by("gsis_id")
        .agg(
            pl.col("full_name").last().alias("name"),
            pl.col("position").last().alias("position"),
            pl.col("team").last().alias("team"),
        )
    )
    if latest.height == 0:
        return []

    picks = _current_class_picks(store, as_of)
    depth = _current_depth_ranks(store, as_of)

    out: list[Rookie] = []
    for row in latest.to_dicts():
        player_id = str(row["gsis_id"])
        name = str(row["name"] or "")
        # Undrafted is a real answer, not a missing one: one slot past the end
        # of the draft is what the market said about him.
        pick = picks.get(normalize_name(name), DRAFT_SIZE + 1)
        out.append(
            Rookie(
                player_id=player_id,
                name=name,
                position=str(row["position"]),
                team=str(row["team"] or ""),
                draft_pick=pick,
                depth_rank=depth.get(player_id),
            )
        )

    return out


def _current_class_picks(store: FeatureStore, as_of: AsOf) -> dict[str, int]:
    """Draft slot for the current class, keyed by normalized name.

    Name matching is used here and nowhere else, because for this one season it
    is the only bridge available — see the identity note above.
    """
    picks = (
        store.as_of("draft_picks", as_of, seasons_back=1)
        .pl()
        .filter(pl.col("season") == as_of.season)
    )
    if picks.height == 0:
        return {}

    out: dict[str, int] = {}
    for row in picks.to_dicts():
        name = row.get("pfr_player_name")
        pick = row.get("pick")
        if not name or pick is None:
            continue
        out[normalize_name(str(name))] = int(pick)
    return out


def _current_depth_ranks(store: FeatureStore, as_of: AsOf) -> dict[str, int]:
    """Most recent listed depth rank per player."""
    ranks = _depth_ranks(store, as_of)
    if ranks.height == 0:
        return {}

    latest = (
        ranks.filter(pl.col("season") == as_of.season)
        .group_by("player_id")
        .agg(pl.col("depth_rank").last())
    )
    return {str(row["player_id"]): int(row["depth_rank"]) for row in latest.to_dicts()}


def project_rookie_stat_lines(
    store: FeatureStore, as_of: AsOf, *, exclude: set[str] | None = None
) -> tuple[dict[str, dict[str, float]], dict[str, float], list[Rookie]]:
    """Stat lines for rookies, in exactly the shape v1 produces.

    Returns `(lines, spreads, rookies)`. `exclude` is the set of ids v1 already
    covered — a player who has played is v1's, always, because real observations
    beat any prior.
    """
    priors = fit(store, as_of)
    if not priors.volume:
        return {}, {}, []

    rookies = [r for r in current_rookies(store, as_of) if r.player_id not in (exclude or set())]

    lines: dict[str, dict[str, float]] = {}
    spreads: dict[str, float] = {}

    for rookie in rookies:
        position = rookie.position
        multiplier = (
            priors.depth.get((position, rookie.depth_rank), 1.0)
            if rookie.depth_rank is not None
            else 1.0
        )

        line: dict[str, float] = {}
        for stat in VOLUME_STATS:
            curve = priors.volume.get((position, stat))
            if curve is None:
                line[stat] = 0.0
                continue
            # The ceiling is re-applied *after* the depth multiplier, not before.
            # Applying it inside `predict` alone let the two compound: a
            # third-overall back sat at the all-time rookie carry ceiling and was
            # then multiplied by the RB1 depth factor, projecting 28 carries a
            # game — more than any rookie has ever had. The cap is a statement
            # about the final number, so it has to be enforced on the final
            # number.
            value = curve.predict(rookie.draft_pick) * multiplier
            line[stat] = min(value, curve.ceiling) if curve.ceiling > 0 else value

        for stat, denominator in RATE_STATS:
            rate = priors.rates.get((position, f"{stat}/{denominator}"))
            line[stat] = rate * line.get(denominator, 0.0) if rate is not None else 0.0

        lines[rookie.player_id] = line
        if position in priors.spread:
            spreads[rookie.player_id] = priors.spread[position]

    return lines, spreads, rookies
