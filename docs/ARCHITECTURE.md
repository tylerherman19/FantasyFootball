# Product architecture and delivery plan

## What is already worth keeping

| Area | Keep | Change next |
| --- | --- | --- |
| League integration | Platform-neutral core plus working Sleeper and Yahoo adapters | Make Sleeper the only supported integration for now; retain the adapter boundary, but defer Yahoo work until the core product is proven. |
| Decision engine | Correct lineup solver, availability handling, simulations, trade/waiver/roster views | Feed it distributions with calibrated correlations rather than a single reused weekly artifact. |
| Research pipeline | DuckDB/Parquet feature store, walk-forward harness, Marcel/v1 usage models, calibration reports | Add source provenance and point-in-time external snapshot tables before expanding models. |
| Scheme research | Opponent adjustment, pace/PROE, scheme artifact and explanatory UI | Keep it contextual until a scheme feature beats the no-scheme model out of sample. Do not multiply a narrative score into player means. |
| Presentation | Light/dark, direct-label visual system, page-per-decision navigation | Consolidate around an Outlook → Matchup → Decision flow and make uncertainty/drivers primary. |

The existing `v2_matchup` experiment is a useful negative result, not dead code: its 2024–25 backtest did not beat the usage model materially, so it should remain unwired while better *team-level* scheme features are evaluated.

## Data contracts

Every ingest record needs four things: `source`, `observed_at`, `available_at`, and a source/version identifier. Models may join only observations whose `available_at < kickoff_at`. The lake manifest now records each downloaded season file, row count, byte size, and serve-time eligibility; live snapshots belong in Postgres/object storage, not reconstructed after the fact.

| Source | Product role | Feasibility and constraint |
| --- | --- | --- |
| nflverse PBP, schedules, rosters, weekly stats, NGS | canonical football history, opportunity, pace, game context | Use as the free research backbone. PBP and weekly files are well suited to Parquet/DuckDB. [nflverse schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html) |
| FTN charting via nflverse | coverage/personnel/formation scheme features | In-season updates are available; derived data requires FTN/nflverse attribution and CC BY-SA review. It is eligible after completed games, not for the current target week. [availability](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html) |
| nflverse participation | retrospective research and stabilization studies | 2023+ participation is released after season end; never a current-season serve feature. [availability](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html) |
| Sleeper | league state, roster, scoring, transactions, picks, trending | Existing adapter is the first-class launch path. The public API is read-only and says commercial use requires licensing discussion. [API terms](https://docs.sleeper.com/) |
| Yahoo Fantasy | user-authorized league state | **Deferred.** Keep the existing OAuth foundation dormant; it requires app approval, OAuth 2.0, attribution, and rate discipline. [developer portal](https://sports.yahoo.com/developer/) |
| The Odds API | pre-kickoff totals/spreads/moneylines and live current market | Use for forward-looking priors. Historical snapshots are paid, so build and retain our own capture stream immediately. [historical odds](https://the-odds-api.com/liveapi/guides/v4/) |
| DynastyProcess | ID crosswalk plus market-value candidate | GPL-3.0 data repository: treat it as a separately licensed input; do not copy code or silently relicense derived files. [repository](https://github.com/dynastyprocess/data) |
| Dynasty Daddy | benchmark for product expectations | Study public UX/features only. Do not scrape its values, trade data, or code; build independent market estimates and disclose their source. [product site](https://dynasty-daddy.com/) |

Before adding FantasyCalc, KeepTradeCut, FantasyPros, player-prop, injury, or paid tracking feeds, create a `SourceContract` covering written permission/terms, refresh cadence, identifiers, retention, attribution, and whether historical point-in-time replay is possible. An accessible endpoint is not approval to redistribute or backtest against it.

## Target system

```text
platform + public data + approved market feeds
                  ↓  (append-only raw snapshots, observed/available timestamps)
       object storage / Parquet lake ──→ DuckDB point-in-time feature views
                  ↓                                  ↓
      Supabase operational snapshots        walk-forward research + calibration
                  ↓                                  ↓
      versioned projection distributions ← artifact registry / promotion gate
                  ↓
     correlated game/season simulations → lineup, waiver, trade, dynasty decisions
                  ↓
  538-style UI: distributions, drivers, historical accuracy, decision consequence
```

Model the offense before the player: market/game prior → team plays and pass rate → QB pressure/depth effect → target/carry allocation constrained to sum to team volume → player efficiency and scoring. Scheme features must enter these components with shrinkage and confidence, rather than as independent per-player boosts. Candidate methods are empirical-Bayes partial pooling for rates, a state-space role model for weekly updates, compositional (softmax/Dirichlet) target allocation, and covariance shrinkage for game simulations. Promotion is based on walk-forward CRPS/log score/calibration as well as MAE.

## Delivery order

1. **Now — truthful data foundation.** Sleeper only. Finish source contracts; add raw snapshot and lake manifests; persist pre-kickoff projections, odds, injuries, schedule, and external market values with `available_at`; make the current FTN-versus-participation availability distinction explicit. This makes later backtests credible.
2. **Next — reproducible baseline.** Run an automated historical lake sync and walk-forward v0/v1 report; version artifacts with data/model/config hashes; publish reliability and coverage by position/week. Backfill completed seasons only from data that would have been available then.
3. **Then — game context.** Build weekly team pace, neutral PROE, play volume, red-zone, and opponent-adjusted defensive features. Evaluate a QB-first/team-volume scheme model against v1; ship only a measured improvement, otherwise retain the existing contextual explanation.
4. **Then — probability decisions.** Export quantiles/samples, calibrate injury and score distributions, and add covariance-aware game/season simulation. Price start/sit, waivers, and trades in delta title/playoff odds, with a "does not matter" threshold.
5. **Then — dynasty market.** Maintain independently sourced, timestamped values/ADP/trade observations; blend market and fundamental value with source-specific bias estimates. Add age/production curves, pick equity from simulated finishes, and transparent uncertainty.
6. **Product pass.** Recompose the UI around League Outlook, Player, Matchup, and Decision pages. The visual rule: every prominent point estimate gets an interval, a driver explanation, source/as-of time, and a link to its accuracy record.

## Explicit non-goals until licensed

No scraping or republishing Dynasty Daddy, KeepTradeCut, FantasyPros, or proprietary tracking feeds; no claim of "coverage" or "shadow" data that the selected source cannot actually provide; and no historical external-projection comparison without snapshots captured at the time.

## Running the foundation

From the repository root, sync the core historical datasets before running the ladder:

```bash
UV_CACHE_DIR=/private/tmp/ffe-uv-cache uv run --project model python -c '
from pathlib import Path
from model.ingest.nflverse import DATASETS, sync
names = {"pbp", "player_stats", "team_stats", "snap_counts", "depth_charts", "injuries", "weekly_rosters", "schedules", "players", "combine", "draft_picks"}
sync(Path("data/lake"), range(2016, 2026), tuple(d for d in DATASETS if d.name in names))
'
UV_CACHE_DIR=/private/tmp/ffe-uv-cache uv run --project model python model/backtest/run_ladder.py 2023 2025
```

The sync resumes safely: existing Parquet files are reused and `data/lake/manifest.json` becomes the exact inventory for subsequent model artifacts.
