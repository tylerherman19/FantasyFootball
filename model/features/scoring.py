"""Sleeper scoring rules, evaluated against nflverse stat lines.

Scoring a stat line ourselves — rather than reading a platform's points column —
is what lets one history serve every league. Tyler's three leagues use 42, 64
and 132 scoring keys respectively; the same 2019 game has to be re-scored three
different ways.

Design rule: **anything we can't compute is reported, never silently zero.**
A quietly unsupported key looks exactly like a player who did nothing, which is
how projections end up confidently wrong about kickers.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import polars as pl

#: Sleeper scoring key -> nflverse column, for stats that map one to one.
DIRECT: dict[str, str] = {
    # passing
    "pass_yd": "passing_yards",
    "pass_td": "passing_tds",
    "pass_int": "passing_interceptions",
    "pass_2pt": "passing_2pt_conversions",
    "pass_cmp": "completions",
    "pass_att": "attempts",
    "pass_fd": "passing_first_downs",
    "pass_sack": "sacks_suffered",
    # rushing
    "rush_yd": "rushing_yards",
    "rush_td": "rushing_tds",
    "rush_att": "carries",
    "rush_fd": "rushing_first_downs",
    "rush_2pt": "rushing_2pt_conversions",
    # receiving
    "rec": "receptions",
    "rec_yd": "receiving_yards",
    "rec_td": "receiving_tds",
    "rec_fd": "receiving_first_downs",
    "rec_2pt": "receiving_2pt_conversions",
    # kicking
    "fgm_0_19": "fg_made_0_19",
    "fgm_20_29": "fg_made_20_29",
    "fgm_30_39": "fg_made_30_39",
    "fgm_40_49": "fg_made_40_49",
    "fgm_50_59": "fg_made_50_59",
    "fgm_60p": "fg_made_60_",
    "fgmiss_0_19": "fg_missed_0_19",
    "fgmiss_20_29": "fg_missed_20_29",
    "fgmiss_30_39": "fg_missed_30_39",
    "fgmiss_40_49": "fg_missed_40_49",
    "fgmiss_50_59": "fg_missed_50_59",
    "fgmiss_60p": "fg_missed_60_",
    "fgm": "fg_made",
    "fgmiss": "fg_missed",
    "xpm": "pat_made",
    "xpmiss": "pat_missed",
    "fgm_yds": "fg_made_distance",
    # individual defensive players
    "idp_tkl_solo": "def_tackles_solo",
    "idp_tkl_ast": "def_tackle_assists",
    "idp_tkl_loss": "def_tackles_for_loss",
    "idp_sack": "def_sacks",
    "idp_sack_yd": "def_sack_yards",
    "idp_int": "def_interceptions",
    "idp_pass_def": "def_pass_defended",
    "idp_ff": "def_fumbles_forced",
    "idp_fum_rec": "def_fumbles",
    "idp_def_td": "def_tds",
    "idp_safe": "def_safeties",
    "idp_qb_hit": "def_qb_hits",
    "idp_blk_kick": "def_fg_blocks",
    # team defense
    "sack": "def_sacks",
    "int": "def_interceptions",
    "ff": "def_fumbles_forced",
    "fum_rec": "def_fumbles",
    "def_td": "def_tds",
    "safe": "def_safeties",
    "sack_yd": "def_sack_yards",
    "qb_hit": "def_qb_hits",
    "def_pass_def": "def_pass_defended",
    "tkl_solo": "def_tackles_solo",
    "tkl_ast": "def_tackle_assists",
    "tkl_loss": "def_tackles_for_loss",
    "blk_kick": "def_fg_blocks",
}

#: Keys whose value is the sum of several columns.
SUMMED: dict[str, tuple[str, ...]] = {
    "fum_lost": ("rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost"),
    "fum": ("rushing_fumbles", "receiving_fumbles", "sack_fumbles"),
    "idp_tkl": ("def_tackles_solo", "def_tackle_assists"),
    "tkl": ("def_tackles_solo", "def_tackle_assists"),
    # Sleeper's 50+ bucket, where a league doesn't split 50-59 from 60+.
    "fgm_50p": ("fg_made_50_59", "fg_made_60_"),
    "fgmiss_50p": ("fg_missed_50_59", "fg_missed_60_"),
}

#: Threshold bonuses: (column, threshold). Awarded once when the stat clears it.
THRESHOLD_BONUS: dict[str, tuple[str, float]] = {
    "bonus_pass_yd_300": ("passing_yards", 300),
    "bonus_pass_yd_400": ("passing_yards", 400),
    "bonus_pass_cmp_25": ("completions", 25),
    "bonus_rush_yd_100": ("rushing_yards", 100),
    "bonus_rush_yd_200": ("rushing_yards", 200),
    "bonus_rush_att_20": ("carries", 20),
    "bonus_rec_yd_100": ("receiving_yards", 100),
    "bonus_rec_yd_200": ("receiving_yards", 200),
    "bonus_sack_2p": ("def_sacks", 2),
    "bonus_tkl_10p": ("def_tackles_solo", 10),
}

#: Keys we knowingly cannot compute from weekly box scores, with the reason.
#: Reported rather than silently scored as zero.
UNSUPPORTED: dict[str, str] = {
    "rec_0_4": "reception-distance buckets need play-level joins",
    "rec_5_9": "reception-distance buckets need play-level joins",
    "rec_10_19": "reception-distance buckets need play-level joins",
    "rec_20_29": "reception-distance buckets need play-level joins",
    "rec_30_39": "reception-distance buckets need play-level joins",
    "rec_40p": "reception-distance buckets need play-level joins",
    "pass_td_40p": "long-TD bonuses need play-level joins",
    "pass_td_50p": "long-TD bonuses need play-level joins",
    "rush_td_40p": "long-TD bonuses need play-level joins",
    "rush_td_50p": "long-TD bonuses need play-level joins",
    "rec_td_40p": "long-TD bonuses need play-level joins",
    "rec_td_50p": "long-TD bonuses need play-level joins",
    "pass_cmp_40p": "long-completion bonuses need play-level joins",
    "rush_40p": "long-run bonuses need play-level joins",
    "def_3_and_out": "drive outcomes are not in weekly team stats",
    "def_4_and_stop": "drive outcomes are not in weekly team stats",
    "def_forced_punts": "drive outcomes are not in weekly team stats",
    "pts_allow": "requires opponent score join (added with team-defense scoring)",
    "yds_allow": "requires opponent yardage join (added with team-defense scoring)",
}

#: Points-allowed and yards-allowed tiers, handled separately because they need
#: the opponent's game result rather than the defense's own stat line.
PTS_ALLOW_TIERS: tuple[tuple[str, float, float], ...] = (
    ("pts_allow_0", 0, 0),
    ("pts_allow_1_6", 1, 6),
    ("pts_allow_7_13", 7, 13),
    ("pts_allow_14_20", 14, 20),
    ("pts_allow_21_27", 21, 27),
    ("pts_allow_28_34", 28, 34),
    ("pts_allow_35p", 35, 999),
)

YDS_ALLOW_TIERS: tuple[tuple[str, float, float], ...] = (
    ("yds_allow_0_100", 0, 99),
    ("yds_allow_100_199", 100, 199),
    ("yds_allow_200_299", 200, 299),
    ("yds_allow_300_349", 300, 349),
    ("yds_allow_350_399", 350, 399),
    ("yds_allow_400_449", 400, 449),
    ("yds_allow_450_499", 450, 499),
    ("yds_allow_500_549", 500, 549),
    ("yds_allow_550p", 550, 99999),
)


@dataclass
class ScoringReport:
    """What a ruleset could and couldn't be evaluated against."""

    applied: list[str] = field(default_factory=list)
    unsupported: dict[str, str] = field(default_factory=dict)
    unknown: list[str] = field(default_factory=list)
    missing_column: dict[str, str] = field(default_factory=dict)

    @property
    def coverage(self) -> float:
        total = len(self.applied) + len(self.unsupported) + len(self.unknown) + len(self.missing_column)
        return len(self.applied) / total if total else 1.0

    def describe(self) -> str:
        lines = [f"scoring coverage {self.coverage:.0%} ({len(self.applied)} keys applied)"]
        for key, reason in sorted(self.unsupported.items()):
            lines.append(f"  unsupported  {key:22s} {reason}")
        for key, column in sorted(self.missing_column.items()):
            lines.append(f"  no column    {key:22s} expected {column}")
        for key in sorted(self.unknown):
            lines.append(f"  unknown key  {key}")
        return "\n".join(lines)


def score_expression(
    rules: dict[str, float],
    available_columns: set[str],
) -> tuple[pl.Expr, ScoringReport]:
    """Build a polars expression scoring one stat row under `rules`.

    Zero-weighted keys are skipped silently — a league that lists `pass_att: 0`
    isn't asking for anything.
    """
    report = ScoringReport()
    total = pl.lit(0.0)

    def column(name: str) -> pl.Expr:
        return pl.col(name).cast(pl.Float64).fill_null(0.0)

    for key, weight in rules.items():
        if weight == 0:
            continue

        if key in UNSUPPORTED:
            report.unsupported[key] = UNSUPPORTED[key]
            continue

        if key in DIRECT:
            target = DIRECT[key]
            if target not in available_columns:
                report.missing_column[key] = target
                continue
            total = total + column(target) * weight
            report.applied.append(key)
            continue

        if key in SUMMED:
            targets = [c for c in SUMMED[key] if c in available_columns]
            if not targets:
                report.missing_column[key] = " + ".join(SUMMED[key])
                continue
            for target in targets:
                total = total + column(target) * weight
            report.applied.append(key)
            continue

        if key in THRESHOLD_BONUS:
            target, threshold = THRESHOLD_BONUS[key]
            if target not in available_columns:
                report.missing_column[key] = target
                continue
            total = total + (column(target) >= threshold).cast(pl.Float64) * weight
            report.applied.append(key)
            continue

        if key.startswith("pts_allow_") or key.startswith("yds_allow_"):
            # Handled by the team-defense path, which has the opponent join.
            report.unsupported.setdefault(key, "team-defense tier, scored separately")
            continue

        report.unknown.append(key)

    return total, report


def score_frame(frame: pl.DataFrame, rules: dict[str, float]) -> tuple[pl.DataFrame, ScoringReport]:
    """Attach a `points` column to a weekly stat frame."""
    expression, report = score_expression(rules, set(frame.columns))
    return frame.with_columns(expression.alias("points")), report
