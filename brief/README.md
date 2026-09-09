# Fantasy Football Weekly Brief

A ground-up rebuild of the FantasyFootball site: a **static, roster-aware weekly
matchup brief** powered by public SumerSports team data and Sleeper rosters.

## What it is

Every week, `build.py` reads your Sleeper rosters and SumerSports team
efficiency data and writes a plain HTML site (`site/`):

- **Per-league pages** — one per Sleeper league you have a roster in. Each of
  your starters gets a matchup brief in the style of SumerSports' weekly
  preview: a **key question** ("Can Pittsburgh find room on the ground against
  Atlanta?") followed by 2–4 sentences grounded in real stats (EPA per
  dropback/rush, success rate), plus a deterministic **Start / Sit / Neutral**
  lean.
- **Waiver-wire watch** — top free agents per league ranked by matchup quality
  (your team's phase efficiency vs. opponent's defensive weakness).
- **Index page** linking all leagues.

No JavaScript, no framework, no server, no API keys. Mobile-friendly.

## The lean rule

For each skill-position starter:

```
edge = (my team's phase EPA − league median)
     + (opponent's allowed phase EPA − league median)
```

Phase is EPA/dropback for QB/WR/TE, EPA/rush for RB. Edge > +0.03 → **Start**;
< −0.03 → **Sit**; otherwise **Neutral**. Team defenses use the inverse (low EPA
allowed is good). Write-ups only use stats actually present in the data —
nothing is estimated or invented.

## Data sources

- **Team stats: [SumerSports](https://sumersports.com/teams/offensive/)**
  (also [defense](https://sumersports.com/teams/defensive/),
  [off. formation tendencies](https://sumersports.com/teams/offensive/formation-tendency/),
  [off. personnel tendencies](https://sumersports.com/teams/offensive/personnel-tendency/),
  [def. formation tendencies](https://sumersports.com/teams/defensive/formation-tendency/),
  [def. personnel tendencies](https://sumersports.com/teams/defensive/personnel-tendency/)).
  Public pages, no login; fetched with the `RSC: 1` header which returns
  structured React Flight data. Stats shown are from the latest completed
  season in SumerSports' data.
- **Rosters: [Sleeper API](https://docs.sleeper.app/)** (public, no auth).

## Refreshing

```bash
python3 fetch_sumer.py    # re-fetch SumerSports team data (polite: sequential, ~2s delays, cached in data/raw/)
python3 fetch_sleeper.py  # re-fetch Sleeper user/leagues/rosters (player map cached in data/raw/)
python3 build.py          # regenerate site/ from data/
```

`fetch_sumer.py` also builds `data/player_index.json` (SumerSports player page
URL index from their public sitemaps) for future per-player enrichment.

## Layout

```
brief/
  build.py            site generator (stdlib only)
  fetch_sumer.py      SumerSports RSC fetcher + parser (stdlib only)
  fetch_sleeper.py    Sleeper fetcher (stdlib only)
  data/
    sumer_teams.json      parsed team stats (offense/defense/tendencies)
    sleeper.json          leagues, rosters, starters, matchups
    schedule.json         this week's NFL slate
    sumer_players.json    waiver candidate pool (name/url/team/position)
    player_index.json     SumerSports player URL index
    raw/                  local caches (not committed)
  site/
    index.html
    leagues/<league_id>.html
```

This directory intentionally does not touch `apps/`, `packages/`, `model/`,
`scripts/`, `supabase/`, or `docs/` — the old site lives there untouched.
