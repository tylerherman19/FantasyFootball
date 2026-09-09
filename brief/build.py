#!/usr/bin/env python3
"""Fantasy-football weekly brief: static HTML site generator.

Reads REAL data files from ../data/ (relative to this script's directory):
    data/sumer_teams.json
    data/sleeper.json
    data/schedule.json
    data/sumer_players.json

Writes a plain static site (no JS, inline CSS) to ./site/:
    site/index.html
    site/leagues/<league_id>.html

Deterministic, template-based generation only: no LLM calls, no API keys,
no network access. Stats are only ever read from the data files; a missing
stat is omitted, never invented.

Usage:  python3 build.py        (run from this directory)
"""

import html
import json
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# TEAM CODE MAPPING
# ---------------------------------------------------------------------------
# SumerSports `teamCode` values are not yet confirmed to match Sleeper's NFL
# abbreviations. This dict maps SumerSports teamCode -> Sleeper abbreviation.
# COORDINATOR: correct these against the real sumer_teams.json teamCode values.
# Watch for non-standard codes like "ARZ" (Sleeper: "ARI") or "JAC" (Sleeper:
# "JAX"); if Sumer uses those, add extra keys mapping them to the Sleeper abbr.
# SumerSports `teamCode` values are NOT the same as Sleeper NFL abbreviations.
# Verified against real SumerSports data (Sep 2026 raw fetch): Sumer uses
# ARZ/BLT/CLV/HST/LA where Sleeper uses ARI/BAL/CLE/HOU/LAR. The dict below
# is pre-filled from that real data; the aliases at the end are harmless
# fallbacks in case either side ever uses the other convention.
TEAM_MAP = {
    "ARZ": "ARI", "ATL": "ATL", "BLT": "BAL", "BUF": "BUF",
    "CAR": "CAR", "CHI": "CHI", "CIN": "CIN", "CLV": "CLE",
    "DAL": "DAL", "DEN": "DEN", "DET": "DET", "GB": "GB",
    "HST": "HOU", "IND": "IND", "JAX": "JAX", "KC": "KC",
    "LAC": "LAC", "LA": "LAR", "LV": "LV", "MIA": "MIA",
    "MIN": "MIN", "NE": "NE", "NO": "NO", "NYG": "NYG",
    "NYJ": "NYJ", "PHI": "PHI", "PIT": "PIT", "SEA": "SEA",
    "SF": "SF", "TB": "TB", "TEN": "TEN", "WAS": "WAS",
    # Aliases (Sleeper-style codes), kept as a safety net:
    "ARI": "ARI", "BAL": "BAL", "CLE": "CLE", "HOU": "HOU", "LAR": "LAR",
}

# SumerSports data URLs used in the footer.
SUMER_URLS = {
    "offensive": "https://sumersports.com/teams/offensive/",
    "defensive": "https://sumersports.com/teams/defensive/",
    "formations": "https://sumersports.com/teams/offensive/formation-tendency/",
    "personnel": "https://sumersports.com/teams/offensive/personnel-tendency/",
    "def_formations": "https://sumersports.com/teams/defensive/formation-tendency/",
    "def_personnel": "https://sumersports.com/teams/defensive/personnel-tendency/",
}

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
OUT_DIR = BASE_DIR / "site"

# ---------------------------------------------------------------------------
# LEAN RULE (documented here, and summarized on each league page)
# ---------------------------------------------------------------------------
# For a skill-position starter we compare the player's team's efficiency in
# the position-relevant phase against the league median, and the opponent's
# defensive allowance in that phase against the league median:
#
#     edge = (my_team_offense_phase - median_offense_phase)
#          + (opp_defense_allowed_phase - median_defense_allowed_phase)
#
# A positive edge means a favorable matchup. Thresholds are in EPA/play units:
#     edge >  +0.03  ->  "Start"
#     edge <  -0.03  ->  "Sit"
#     otherwise      ->  "Neutral"
#
# For team defenses the rule is inverted (low EPA allowed is good):
#     edge = (median_allowed - my_defense_allowed) + (median_offense - opp_offense)
#
# Phase mapping: QB -> epaPerDropback / epaPerDropbackAllowed
#                RB -> epaPerRush / epaPerRushAllowed
#                WR/TE -> epaPerDropback / epaPerDropbackAllowed
#                K -> epaPerPlay / epaPerPlayAllowed (one-liner only)
#                DEF -> epaPerPlayAllowed / epaPerPlay (one-liner only)
LEAN_THRESHOLD = 0.03

PHASES = {
    "QB": ("epaPerDropback", "epaPerDropbackAllowed"),
    "RB": ("epaPerRush", "epaPerRushAllowed"),
    "WR": ("epaPerDropback", "epaPerDropbackAllowed"),
    "TE": ("epaPerDropback", "epaPerDropbackAllowed"),
}

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def esc(text):
    return html.escape("" if text is None else str(text), quote=True)


def fmt_epa(x):
    """Format an EPA number; None -> None (caller omits the stat)."""
    if x is None:
        return None
    try:
        return f"{float(x):+.2f}"
    except (TypeError, ValueError):
        return None


def fmt_pct(x):
    if x is None:
        return None
    try:
        return f"{float(x):.1f}%"
    except (TypeError, ValueError):
        return None


def median(values):
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    n = len(vals)
    mid = n // 2
    if n % 2:
        return vals[mid]
    return (vals[mid - 1] + vals[mid]) / 2


def lean_from_edge(edge):
    if edge is None:
        return "Neutral"
    if edge > LEAN_THRESHOLD:
        return "Start"
    if edge < -LEAN_THRESHOLD:
        return "Sit"
    return "Neutral"


def offense_edge(off_phase, opp_allowed, med_off, med_def):
    """Favorable if my offense is efficient AND opp defense allows a lot."""
    if off_phase is None or opp_allowed is None or med_off is None or med_def is None:
        return None
    return (off_phase - med_off) + (opp_allowed - med_def)


def defense_edge(my_allowed, opp_offense, med_allowed, med_off):
    """Favorable if my defense allows little AND opp offense is weak."""
    if my_allowed is None or opp_offense is None or med_allowed is None or med_off is None:
        return None
    return (med_allowed - my_allowed) + (med_off - opp_offense)


def team_name(abbr, off_rows, def_rows):
    row = off_rows.get(abbr) or def_rows.get(abbr)
    if row and row.get("longName"):
        return row["longName"]
    return abbr


# ---------------------------------------------------------------------------
# matchup briefs (template-based; every sentence requires the stats present)
# ---------------------------------------------------------------------------

def key_question(pos, pname, my_label, opp_label):
    if pos == "QB":
        return f"What will {my_label}'s pass protection look like against {opp_label}'s front?"
    if pos == "RB":
        return f"Can {my_label} find room on the ground against {opp_label}?"
    if pos == "WR":
        return f"Can {my_label}'s passing game separate from {opp_label}'s coverage?"
    if pos == "TE":
        return f"Will {pname} find soft spots against {opp_label}'s coverage?"
    if pos == "K":
        return "Kicker outlook"
    if pos == "DEF":
        return "Defense outlook"
    return "Matchup outlook"


def skill_sentences(pos, off, opp_def, my_label, opp_label):
    """Return a list of grounded sentences for a skill-position player."""
    s = []
    if pos in ("QB", "WR", "TE"):
        epa_o = fmt_epa(off.get("epaPerDropback"))
        epa_d = fmt_epa(opp_def.get("epaPerDropbackAllowed"))
        if epa_o is not None and epa_d is not None:
            s.append(
                f"{my_label} averaged {epa_o} EPA per dropback; "
                f"{opp_label} allowed {epa_d} EPA per dropback."
            )
        pa = fmt_pct(off.get("playActionPct"))
        if pos in ("QB", "WR", "TE") and pa is not None:
            s.append(f"{my_label} used play action on {pa} of dropbacks.")
        succ_o = fmt_pct(off.get("successPct"))
        succ_d = fmt_pct(opp_def.get("successPctAllowed"))
        if succ_o is not None and succ_d is not None:
            s.append(
                f"{my_label} succeeded on {succ_o} of plays; "
                f"{opp_label} allowed a {succ_d} success rate."
            )
        p11 = fmt_pct(off.get("personnel11Pct"))
        if pos in ("WR", "TE") and p11 is not None:
            s.append(f"{my_label} lined up in 11 personnel on {p11} of snaps.")
        if pos == "QB":
            press_o = fmt_pct(off.get("pressureAllowedPct"))
            press_d = fmt_pct(opp_def.get("pressurePct"))
            if press_d is not None and press_o is not None:
                s.append(
                    f"{opp_label}'s defense generated pressure on {press_d} of dropbacks; "
                    f"{my_label} allowed pressure on {press_o}."
                )
    elif pos == "RB":
        epa_o = fmt_epa(off.get("epaPerRush"))
        epa_d = fmt_epa(opp_def.get("epaPerRushAllowed"))
        if epa_o is not None and epa_d is not None:
            s.append(
                f"{my_label} averaged {epa_o} EPA per rush; "
                f"{opp_label} allowed {epa_d} EPA per rush."
            )
        epa_play_o = fmt_epa(off.get("epaPerPlay"))
        epa_play_d = fmt_epa(opp_def.get("epaPerPlayAllowed"))
        if epa_play_o is not None and epa_play_d is not None:
            s.append(
                f"Overall, {my_label} posted {epa_play_o} EPA per play while "
                f"{opp_label} allowed {epa_play_d}."
            )
    return s


def player_brief(p, off_rows, def_rows, sched, medians):
    """Return an HTML card for one starter, or an 'unavailable' card."""
    name = p.get("name") or "Unknown player"
    pos = (p.get("position") or "").upper()
    team = p.get("team")
    injury = p.get("injury_status")

    def unavailable():
        return (
            f'<article class="card unavailable">'
            f'<h3>{esc(name)} <span class="pos">{esc(pos)}</span></h3>'
            f'<p class="muted">matchup data unavailable</p>'
            f"</article>"
        )

    if not team:
        return unavailable()
    game = sched.get(team)
    if not game:
        return unavailable()
    opp = game["opp"]
    off = off_rows.get(team)
    opp_def = def_rows.get(opp)
    my_label = team_name(team, off_rows, def_rows)
    opp_label = team_name(opp, off_rows, def_rows)
    game_note = f"{team} {'vs' if game['home'] else '@'} {opp} · {game['label']}"

    if pos in ("K", "DEF"):
        # Short one-liners from team efficiency.
        if pos == "K":
            if not off or not opp_def:
                return unavailable()
            xo = fmt_epa(off.get("epaPerPlay"))
            yd = fmt_epa(opp_def.get("epaPerPlayAllowed"))
            line = "Kicker outlook."
            if xo is not None and yd is not None:
                line = f"{my_label} averaged {xo} EPA per play; {opp_label} allowed {yd} EPA per play."
            edge = offense_edge(off.get("epaPerPlay"), opp_def.get("epaPerPlayAllowed"),
                                medians.get("epaPerPlay"), medians.get("epaPerPlayAllowed"))
            lean = lean_from_edge(edge)
        else:  # DEF
            my_def = def_rows.get(team)
            opp_off = off_rows.get(opp)
            if not my_def or not opp_off:
                return unavailable()
            xa = fmt_epa(my_def.get("epaPerPlayAllowed"))
            yo = fmt_epa(opp_off.get("epaPerPlay"))
            line = "Defense outlook."
            if xa is not None and yo is not None:
                line = f"{my_label} allowed {xa} EPA per play; {opp_label} averaged {yo} EPA per play."
            edge = defense_edge(my_def.get("epaPerPlayAllowed"), opp_off.get("epaPerPlay"),
                                medians.get("epaPerPlayAllowed"), medians.get("epaPerPlay"))
            lean = lean_from_edge(edge)
        badge = f'<span class="lean lean-{lean.lower()}">{lean}</span>'
        inj = f' <span class="inj">{esc(injury)}</span>' if injury else ""
        return (
            f'<article class="card">'
            f'<h3>{esc(name)}{inj} <span class="pos">{esc(pos)}</span> {badge}</h3>'
            f'<p class="gamenote">{esc(game_note)}</p>'
            f'<p><strong>{esc(key_question(pos, name, my_label, opp_label))}</strong></p>'
            f'<p>{esc(line)}</p>'
            f"</article>"
        )

    # Skill positions (QB/RB/WR/TE).
    if not off or not opp_def:
        return unavailable()
    off_key, def_key = PHASES.get(pos, ("epaPerDropback", "epaPerDropbackAllowed"))
    edge = offense_edge(off.get(off_key), opp_def.get(def_key),
                        medians.get(off_key), medians.get(def_key))
    lean = lean_from_edge(edge)
    sentences = skill_sentences(pos, off, opp_def, my_label, opp_label)
    body = " ".join(sentences) if sentences else "No efficiency stats available for this matchup."
    badge = f'<span class="lean lean-{lean.lower()}">{lean}</span>'
    inj = f' <span class="inj">{esc(injury)}</span>' if injury else ""
    return (
        f'<article class="card">'
        f'<h3>{esc(name)}{inj} <span class="pos">{esc(pos)} · {esc(team)}</span> {badge}</h3>'
        f'<p class="gamenote">{esc(game_note)}</p>'
        f'<p class="keyq"><strong>{esc(key_question(pos, name, my_label, opp_label))}</strong></p>'
        f'<p>{esc(body)}</p>'
        f"</article>"
    )


# ---------------------------------------------------------------------------
# waiver watch list
# ---------------------------------------------------------------------------

def waiver_watch(league, all_players, off_rows, def_rows, sched, medians, limit=5):
    """Rank free agents by matchup quality; return list of (player, opp, why, edge)."""
    rostered = set()
    for r in league.get("rosters", []):
        for pl in r.get("players", []) or []:
            nm = (pl.get("name") or "").strip().lower()
            if nm:
                rostered.add(nm)

    cands = []
    for pl in all_players:
        pos = (pl.get("position") or "").upper()
        team = pl.get("team")
        name = pl.get("name") or "Unknown player"
        if pos not in ("QB", "RB", "WR", "TE"):
            continue
        if not team:
            continue
        if name.strip().lower() in rostered:
            continue
        game = sched.get(team)
        if not game:
            continue
        opp = game["opp"]
        off = off_rows.get(team)
        opp_def = def_rows.get(opp)
        if not off or not opp_def:
            continue
        off_key, def_key = PHASES[pos]
        edge = offense_edge(off.get(off_key), opp_def.get(def_key),
                            medians.get(off_key), medians.get(def_key))
        if edge is None:
            continue
        my_label = team_name(team, off_rows, def_rows)
        opp_label = team_name(opp, off_rows, def_rows)
        why_bits = []
        eo = fmt_epa(off.get(off_key))
        ed = fmt_epa(opp_def.get(def_key))
        phase = "dropback" if "Dropback" in off_key else "rush"
        if eo is not None and ed is not None:
            why_bits.append(f"{my_label} at {eo} EPA/{phase}; {opp_label} allows {ed}")
        why = "; ".join(why_bits) if why_bits else "favorable efficiency matchup"
        cands.append((edge, name, team, pos, opp, why))

    cands.sort(key=lambda c: c[0], reverse=True)
    # One player per NFL team so the list isn't five depth charts from one roster.
    seen_teams, deduped = set(), []
    for c in cands:
        if c[2] not in seen_teams:
            seen_teams.add(c[2])
            deduped.append(c)
        if len(deduped) >= limit:
            break
    return deduped


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

CSS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
       margin: 0; padding: 0 1rem 3rem; color: #1a1a1a; background: #fafafa; line-height: 1.55; }
.wrap { max-width: 700px; margin: 0 auto; }
header.site { padding: 1.5rem 0 0.5rem; border-bottom: 3px solid #1a1a1a; margin-bottom: 1.5rem; }
header.site h1 { margin: 0 0 0.25rem; font-size: 1.6rem; }
header.site .sub { color: #555; margin: 0 0 0.5rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 0.75rem; }
.card { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 1rem 1.1rem; margin: 0 0 0.9rem; }
.card h3 { margin: 0 0 0.3rem; font-size: 1.05rem; }
.card .pos { font-weight: normal; color: #555; font-size: 0.85rem; }
.card .gamenote { color: #666; font-size: 0.85rem; margin: 0 0 0.5rem; }
.card .keyq { margin: 0.4rem 0 0.4rem; }
.card p { margin: 0.35rem 0; }
.card.unavailable { border-style: dashed; background: #f4f4f4; }
.lean { display: inline-block; font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.04em; padding: 0.15rem 0.55rem; border-radius: 999px; vertical-align: middle; }
.lean-start { background: #d9f2d9; color: #166316; border: 1px solid #9ed69e; }
.lean-sit { background: #fbdcdc; color: #8f1d1d; border: 1px solid #e8a3a3; }
.lean-neutral { background: #e8e8e8; color: #555; border: 1px solid #ccc; }
.inj { display: inline-block; font-size: 0.72rem; font-weight: 700; color: #8a5a00; background: #fff3d6;
       border: 1px solid #e6c46a; border-radius: 4px; padding: 0.1rem 0.4rem; vertical-align: middle; }
.bench { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 0.8rem 1.1rem; }
.bench li { margin: 0.25rem 0; }
.waiver { list-style: none; padding: 0; margin: 0; }
.waiver li { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 0.8rem 1.1rem; margin: 0 0 0.7rem; }
.waiver .wname { font-weight: 700; }
.waiver .wmeta { color: #555; font-size: 0.9rem; }
.leaguelist { list-style: none; padding: 0; }
.leaguelist li { margin: 0 0 0.6rem; }
.leaguelist a { display: block; background: #fff; border: 1px solid #ddd; border-radius: 10px;
                padding: 0.9rem 1.1rem; text-decoration: none; color: #1a1a1a; font-weight: 700; }
.leaguelist a:hover { border-color: #999; }
.method { background: #f0f4f8; border: 1px solid #d5dee8; border-radius: 10px; padding: 0.8rem 1.1rem;
          font-size: 0.9rem; color: #333; }
footer.site { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #ccc; color: #666; font-size: 0.85rem; }
footer.site a { color: #0b5cad; }
.muted { color: #777; }
@media (max-width: 480px) {
  body { padding: 0 0.75rem 2.5rem; }
  header.site h1 { font-size: 1.35rem; }
}
"""


def footer_html():
    return (
        '<footer class="site"><div class="wrap">'
        'Data: <a href="' + SUMER_URLS["offensive"] + '">SumerSports offensive team stats</a> · '
        '<a href="' + SUMER_URLS["defensive"] + '">defensive team stats</a> · '
        '<a href="' + SUMER_URLS["formations"] + '">off. formation tendencies</a> · '
        '<a href="' + SUMER_URLS["personnel"] + '">off. personnel tendencies</a> · '
        '<a href="' + SUMER_URLS["def_formations"] + '">def. formation tendencies</a> · '
        '<a href="' + SUMER_URLS["def_personnel"] + '">def. personnel tendencies</a>'
        ' &nbsp;|&nbsp; Rosters: Sleeper'
        "</div></footer>"
    )


def page_shell(title, body, generated):
    return (
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{esc(title)}</title>\n"
        f"<style>{CSS}</style>\n"
        "</head>\n<body>\n"
        f"{body}\n"
        f"{footer_html()}\n"
        "</body>\n</html>\n"
    )


def league_page(league, week, off_rows, def_rows, sched, medians, all_players, generated):
    lname = league.get("name") or "Unnamed league"
    lid = league.get("league_id") or "unknown"

    rosters = league.get("rosters", [])
    mine = next((r for r in rosters if r.get("is_mine")), None)
    if mine is None:
        raise ValueError(f"league {lid}: no roster with is_mine=true")

    # Fantasy matchup opponent (owner name), if present.
    opp_name = None
    for m in league.get("matchups", []) or []:
        if m.get("roster_id") == mine.get("roster_id"):
            opp_id = m.get("opponent_roster_id")
            opp_r = next((r for r in rosters if r.get("roster_id") == opp_id), None)
            if opp_r:
                opp_name = opp_r.get("owner_name")
            break

    parts = []
    parts.append('<header class="site"><div class="wrap">')
    parts.append(f"<h1>{esc(lname)}</h1>")
    sub = f"Week {week} matchup brief"
    if opp_name:
        sub += f" · vs {esc(opp_name)}"
    parts.append(f'<p class="sub">{sub}</p>')
    parts.append(f'<p class="sub muted">Generated {esc(generated)}</p>')
    season = next(iter(off_rows.values()), {}).get("season")
    if season:
        parts.append(f'<p class="sub muted">Team efficiency stats: {esc(str(season))} season (latest available)</p>')
    parts.append("</div></header>")
    parts.append('<div class="wrap">')

    # My roster.
    parts.append(f"<h2>My roster — {esc(mine.get('owner_name') or 'me')}</h2>")
    starters = mine.get("starters") or []
    starter_ids = {s.get("player_id") for s in starters}
    for s in starters:
        parts.append(player_brief(s, off_rows, def_rows, sched, medians))

    # Bench: starters excluded; compact list, no write-ups.
    players = mine.get("players") or []
    bench = [p for p in players if p.get("player_id") not in starter_ids]
    if bench:
        parts.append("<h2>Bench</h2>")
        parts.append('<ul class="bench">')
        for p in bench:
            nm = p.get("name") or "Unknown player"
            pos = (p.get("position") or "").upper()
            team = p.get("team") or "—"
            inj = p.get("injury_status")
            inj_txt = f" ({esc(inj)})" if inj else ""
            parts.append(f"<li>{esc(nm)}{inj_txt} — {esc(pos)}, {esc(team)}</li>")
        parts.append("</ul>")

    # Waiver wire.
    watch = waiver_watch(league, all_players, off_rows, def_rows, sched, medians)
    parts.append("<h2>Waiver-wire watch</h2>")
    if watch:
        parts.append('<ul class="waiver">')
        for edge, name, team, pos, opp, why in watch:
            parts.append(
                f"<li><span class='wname'>{esc(name)}</span> "
                f"<span class='wmeta'>{esc(team)} · {esc(pos)} · this week vs {esc(opp)}</span><br>"
                f"<span class='wmeta'>{esc(why)}</span></li>"
            )
        parts.append("</ul>")
    else:
        parts.append('<p class="muted">No waiver candidates with usable matchup data this week.</p>')

    # Method note (brief on-page documentation of the lean rule).
    parts.append("<h2>How leans work</h2>")
    parts.append(
        '<div class="method"><p>Each starter gets a deterministic lean. '
        "We compare the player's team efficiency in the position-relevant phase "
        "(EPA per dropback for QBs/WRs/TEs, EPA per rush for RBs) against the league median, "
        "and add how much EPA the opponent's defense allows in that phase relative to median. "
        "A combined edge above +0.03 EPA/play is a <strong>Start</strong>; below −0.03 is a "
        "<strong>Sit</strong>; anything between is <strong>Neutral</strong>. "
        "Team defenses use the inverse (low EPA allowed is good). "
        "Write-ups only use stats actually present in the data — nothing is estimated.</p></div>"
    )

    parts.append('<p><a href="../index.html">← All leagues</a></p>')
    parts.append("</div>")

    return page_shell(f"{lname} — Week {week} brief", "\n".join(parts), generated)


def index_page(leagues, week, generated):
    parts = []
    parts.append('<header class="site"><div class="wrap">')
    parts.append("<h1>Fantasy Football Weekly Brief</h1>")
    parts.append(f'<p class="sub">Week {week}</p>')
    parts.append(f'<p class="sub muted">Generated {esc(generated)}</p>')
    parts.append("</div></header>")
    parts.append('<div class="wrap">')
    parts.append("<h2>Leagues</h2>")
    parts.append('<ul class="leaguelist">')
    for lg in leagues:
        lid = lg.get("league_id") or "unknown"
        lname = lg.get("name") or "Unnamed league"
        parts.append(f'<li><a href="leagues/{esc(lid)}.html">{esc(lname)}</a></li>')
    parts.append("</ul>")
    parts.append(
        '<p class="muted">Matchup analysis uses SumerSports team efficiency stats; '
        "rosters come from Sleeper.</p>"
    )
    parts.append("</div>")
    return page_shell(f"Fantasy Football Weekly Brief — Week {week}", "\n".join(parts), generated)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    missing = [p.name for p in
               [DATA_DIR / "sumer_teams.json", DATA_DIR / "sleeper.json",
                DATA_DIR / "schedule.json", DATA_DIR / "sumer_players.json"]
               if not p.exists()]
    if missing:
        raise SystemExit(
            "Missing data files in data/: " + ", ".join(missing) +
            ". (Development fixtures live in data/fixtures/; copy them over to test.)"
        )

    teams = load_json(DATA_DIR / "sumer_teams.json")
    sleeper = load_json(DATA_DIR / "sleeper.json")
    schedule = load_json(DATA_DIR / "schedule.json")
    players_doc = load_json(DATA_DIR / "sumer_players.json")

    week = sleeper.get("week") or schedule.get("week") or "?"

    # Index SumerSports rows by Sleeper abbreviation via TEAM_MAP.
    off_rows, def_rows = {}, {}
    for row in teams.get("offense", []) or []:
        abbr = TEAM_MAP.get(row.get("teamCode"))
        if abbr:
            off_rows[abbr] = row
    for row in teams.get("defense", []) or []:
        abbr = TEAM_MAP.get(row.get("teamCode"))
        if abbr:
            def_rows[abbr] = row

    # Schedule: team -> {opp, home, label}.
    sched = {}
    for g in schedule.get("games", []) or []:
        away, home, label = g.get("away"), g.get("home"), g.get("label") or ""
        if away and home:
            sched[away] = {"opp": home, "home": False, "label": label}
            sched[home] = {"opp": away, "home": True, "label": label}

    # League-wide medians per phase key (over teams that have the stat).
    phase_keys = ["epaPerPlay", "epaPerDropback", "epaPerRush",
                  "epaPerPlayAllowed", "epaPerDropbackAllowed", "epaPerRushAllowed"]
    medians = {}
    for key in phase_keys:
        vals = [r.get(key) for r in list(off_rows.values()) + list(def_rows.values())
                if isinstance(r.get(key), (int, float))]
        medians[key] = median(vals)

    all_players = players_doc.get("players", []) or []
    generated = datetime.now().astimezone().strftime("%b %d, %Y · %I:%M %p %Z").replace(" 0", " ")

    leagues_dir = OUT_DIR / "leagues"
    leagues_dir.mkdir(parents=True, exist_ok=True)

    leagues = [lg for lg in (sleeper.get("leagues", []) or [])
               if any(r.get("is_mine") for r in (lg.get("rosters") or []))]
    for lg in leagues:
        lid = lg.get("league_id") or "unknown"
        html_doc = league_page(lg, week, off_rows, def_rows, sched, medians, all_players, generated)
        (leagues_dir / f"{lid}.html").write_text(html_doc, encoding="utf-8")

    (OUT_DIR / "index.html").write_text(index_page(leagues, week, generated), encoding="utf-8")
    print(f"Built {len(leagues)} league page(s) -> {OUT_DIR}")


if __name__ == "__main__":
    main()
