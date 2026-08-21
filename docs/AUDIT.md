# Fantasy Football Edge — Architecture Audit

> **Status note, added after the audit was written.** Findings §9.1 (rookies),
> §9.2 (refresh), §9.4 (byes) and part of §5 (team identity) have since been
> fixed; §12–15 remain the plan of record and are largely unbuilt. See
> [Work completed](#work-completed-since-this-audit) at the end. Everything
> between here and there is the state as found, and is left unedited so the
> before/after is legible.

**Date:** 2026-08-21
**Commit audited:** `35149a0` ("One navigation at a time")
**Live app:** https://fantasy-football-edge.vercel.app/ — HTTP 200, renders, three leagues resolve
**Method:** full source read, execution of the Python model against the local data lake, live HTTP
inspection, PostgREST row counts against the production Supabase project, and git history.

Every claim below is backed by a number or a file:line reference. Where a function exists but does
not do what its name suggests, that is stated as a finding rather than a feature.

---

## 0. Headline

The brief describes the current application as "a prototype." That framing is wrong in a way that
matters for sequencing, so the audit corrects it up front.

This repository already contains a real quantitative pipeline: an empirical-Bayes shrinkage model
with stabilization constants computed from the project's own data, a point-in-time feature store, a
walk-forward backtest harness with proper scoring, a calibration pass that measured and corrected
forecast spread, and a matchup model that was built, measured against the harness, found not to help,
and **deliberately not shipped** (commit `33d19ce`). That last item is the single strongest signal in
the repository — it is the discipline most fantasy analytics products never apply to themselves.

What is broken is not the modeling philosophy. It is:

1. **Rookies produce no projection at all.** Verified, not inferred (§9.1).
2. **The refresh loop has never once run successfully.** Verified from git history (§9.2).
3. **There is no canonical database.** Serving reads committed JSON files (§9.3).
4. **Bye weeks are computed from the wrong thing** and propagate that error across the whole
   rest-of-season simulation (§9.4).
5. **The decision layer exists in `packages/core` but is thinly surfaced**, and the UI is organized
   around data pages rather than around decisions (§9.6).

The recommended order therefore extends what is measured rather than rebuilding it. Rewriting the
projection engine would discard the only part of this system that has been validated.

---

## 1. Current architecture

An npm workspaces monorepo, Node ≥ 22, TypeScript strict, ESM throughout.

```
apps/web              Next.js 16.3.1 (App Router), React 19.2.8, Tailwind v4
packages/core         pure TS — domain, projections, sim, decisions, valuation, metrics
packages/adapters     Sleeper + Yahoo behind one PlatformAdapter interface
packages/ingest       Odds API, FantasyCalc values, Supabase PostgREST stores
model/                Python 3.12 via uv — features, models, backtest, artifact export
supabase/migrations   two migrations
data/lake             nflverse parquet, 18 datasets
scripts/              smoke-sleeper, snapshot, export-static
```

**Size:** 21,636 lines across TS/TSX/Python.

**The load-bearing architectural decision** is the Python/TypeScript seam. Python trains offline and
writes versioned JSON artifacts to `model/artifacts/`; TypeScript reads them at request time. Python
never runs in the serving path. This is correct and should be preserved.

**The artifact contains stat lines, not fantasy points** (`model/export_projections.py:1-12`). This
is the single best design decision in the repo. Tyler's three leagues use 42, 64 and 132 distinct
scoring keys — one full IDP, one with distance-banded field goals and yardage-allowed tiers.
Exporting points under any one ruleset would silently hand two of three leagues wrong numbers. The
model projects what a player will *do*; each league scores it its own way
(`packages/core/src/projections/scoring.ts`).

**Serving path, end to end:**

```
Sleeper API ──► SleeperAdapter ──► domain model ──┐
                                                   ├──► page render
model/artifacts/*.json ──► loadArtifact() ────────┤
                                                   └──► season sim (in-process) ──► odds
```

There is no database in that path. §9.3.

**Caching** is a hand-rolled TTL memo (`apps/web/src/lib/cache.ts`) anchored on a `globalThis`
symbol. The comment explains why: Next bundles the instrumentation hook and route handlers
separately, so a module-scope `Map` instantiates more than once per server process and each copy
caches independently. Concurrent callers share one in-flight promise; failed computations are not
cached. This is a correct, well-reasoned implementation of the wrong layer — it is a per-process
memo standing in for a database.

**Routes** (all under `app/league/[leagueId]/`): index, `lineup`, `roster`, `power`, `dynasty`,
`trades`, `waivers`, `schedule`, `scheme`, `usage`. Ten pages, all server components.

**API routes:** exactly two, both Yahoo OAuth (`/api/auth/yahoo`, `/api/auth/yahoo/callback`).
There is no data API, no refresh endpoint, no cron endpoint.

---

## 2. Current database schema

Two migrations, both snapshot tables. Live row counts pulled from production via PostgREST on
2026-08-21:

| Table | Purpose | Rows |
|---|---|---|
| `projection_snapshots` | pre-kickoff projection capture, scored after | **511** |
| `value_snapshots` | daily market value series per player/market | **1,316** |
| `odds_snapshots` | Vegas totals/spreads, de-vigged | **422** |

`projection_snapshots` is well designed: unique on `(season, week, player_id, source,
source_version, scoring_key)`, a partial index on the unscored queue, and a
`projection_snapshots_valid` view that excludes rows captured after kickoff — hindsight contamination
is structurally flagged rather than trusted to discipline.

**What does not exist:** any table for players, teams, games, plays, weekly stats, features,
projections (as opposed to snapshots of them), injuries, schedules, weather, dynasty values, league
settings, rosters, transactions, simulations, model versions, data sources, or refresh logs. Of the
~24 entities the brief lists in §80, **three exist**.

The row counts also tell a story: 511 projection snapshots across a 2,313-player artifact means
roughly one week of partial capture, not a season of accumulated accuracy record. The moat has
approximately one inch of water in it.

---

## 3. Current data providers

| Provider | What it supplies | How it is fetched | Status |
|---|---|---|---|
| **nflverse** | pbp, weekly stats, snap counts, depth charts, rosters, schedules, injuries, NGS, FTN charting, participation, combine, draft picks | `model/ingest/nflverse.py` → parquet under `data/lake/` | **Working. Last synced Aug 17 — 4 days stale.** |
| **DynastyProcess** | `db_playerids.csv` player crosswalk | `model/ingest/crosswalk.py` | Working. 7,983 identities, 7,804 with gsis. |
| **Sleeper** | leagues, rosters, matchups, transactions, traded picks, drafts, trending | `packages/adapters/src/sleeper/client.ts` | Working, live, no key needed. |
| **Yahoo** | leagues, rosters, `percent_owned` | `packages/adapters/src/yahoo/` (OAuth2) | Code complete, credentials set, **not exercised in the live app.** |
| **The Odds API** | NFL totals + spreads | `packages/ingest/src/odds.ts` | Key set. 422 snapshots captured. |
| **FantasyCalc** | dynasty/redraft values, ADP, roster % | `packages/ingest/src/values.ts` | Working. 1,316 snapshots. |

**No weather provider.** The brief requires one (§17). Nothing in the repo fetches weather.

**Lake contents** (18 datasets): `pbp`, `pbp_participation`, `player_stats` (2016–2025),
`team_stats`, `snap_counts`, `depth_charts` (2024–2026), `weekly_rosters` (2024–2026), `injuries`
(2023–2025), `schedules` (through 2026 wk 22), `players`, `draft_picks`, `combine`, `ftn_charting`,
`ngs_passing`, `ngs_receiving`, `ngs_rushing`.

The raw material for most of what the brief asks for is **already on disk**. Route participation,
aDOT, air yards, YAC, pressure rate, coverage shell — these live in `ftn_charting`,
`pbp_participation` and the NGS tables, all downloaded, almost none of them used.

---

## 4. Current data refresh process

There is one refresh mechanism: a GitHub Actions workflow, `.github/workflows/snapshot.yml`, on cron
`0 16 * * 2` (Tuesday 16:00 UTC). It snapshots projections, re-syncs nflverse, rebuilds the
crosswalk, re-exports projections, and commits `model/artifacts` back to `main`.

**It has never successfully run.**

```
$ git log --all --oneline --grep='Weekly projections refresh'
(no output)
```

The workflow's own commit message is `"Weekly projections refresh [skip ci]"`. Zero such commits
exist on any branch. The cron should have fired Tuesday 2026-08-18. Corroborating evidence:

- `data/lake/**/*.parquet` mtimes: **Aug 17 17:46**, i.e. the last manual local sync.
- `model/artifacts/projections-2026-01.json` `generatedAt`: **2026-08-18T03:34:36Z** — also local.
- `model/artifacts/defense-scheme.json`, `player-history.json`: **Aug 19 23:28**, local.

So the deployed application is serving artifacts committed by hand, and the automation that was
supposed to keep them current has not produced a single commit. This is the mechanical cause of the
staleness the brief complains about.

**There is no on-demand refresh of any kind.** No API route, no server action, no CLI target that a
user can trigger. `vercel.json` declares no `crons`. The only recourse today is to run the Python
pipeline locally and `git push`.

**Nothing anywhere records refresh state.** No `last_attempted_at`, `last_success_at`, record counts,
provider status, or error text — for any source. There is therefore no way for the UI to know whether
what it is showing is four minutes or four months old, which is why it does not say.

---

## 5. Current player identity system

The crosswalk is built from a single source: DynastyProcess's `db_playerids.csv`
(`model/ingest/crosswalk.py:29`), keyed by `sleeper_id`, carrying `gsis_id`, `yahoo_id`, `espn_id`,
name, position, team, birthdate and draft capital. Team defenses are synthesized separately, since
Sleeper identifies them by team abbreviation rather than a player id. Exported as
`model/artifacts/crosswalk.json` (1.7 MB, 7,983 identities) and read by both Python and TS.

**Verified coverage of the 2026 rookie class:**

| Player | Draft | Sleeper ID | In crosswalk | gsis_id | Projected |
|---|---|---|---|---|---|
| Fernando Mendoza | 1.01 LV | 13269 | ✅ | 00-0041562 | ❌ |
| David Bailey | 1.02 NYJ | — | ✅ | — | ❌ |
| Jeremiyah Love | 1.03 ARI | 13287 | ✅ | 00-0041027 | ❌ |
| Carnell Tate | 1.04 TEN | 13279 | ✅ | 00-0041438 | ❌ |
| Jordyn Tyson | 1.08 NO | 13281 | ✅ | 00-0041029 | ❌ |

**The crosswalk is not the problem.** Every rookie checked resolves, with a gsis id. Of the 183
players in `weekly_rosters/2026.parquet` with `years_exp = 0` and a Sleeper id, **183 of 183 are in
the crosswalk, all with gsis ids.**

The failure is one layer down, in the projection model. See §9.1.

**A genuine identity weakness does exist**, and it is architectural rather than incidental: identity
depends entirely on one third-party CSV. Meanwhile `weekly_rosters/2026.parquet` — already on disk —
carries `sleeper_id`, `gsis_id`, `yahoo_id`, `espn_id`, `pfr_id`, `pff_id`, `sportradar_id`,
`fantasy_data_id`, `rotowire_id` **for 2,930 players**, with `gsis_id` populated on all 2,930 and
`sleeper_id` on 1,820. That is a first-party join sitting unused behind a single-vendor dependency.

There is also no internal canonical id. `sleeper_id` is the de facto primary key throughout, which
means the "platform-neutral" domain model is in fact Sleeper-shaped, and a player without a Sleeper
id cannot be represented at all.

---

## 6. Current modeling system

Real, and better than the brief assumes. The ladder from `docs/PLAN.md` is partially climbed.

**v0 — Marcel** (`model/models/marcel.py`). Recency-weighted multi-season average regressed to the
positional mean. Exists as the baseline every later rung must beat.

**v1 — opportunity × efficiency** (`model/models/v1_usage.py`, 300 lines). The shipping model. It
decomposes fantasy scoring into the identity `Σ(opportunities × rate × weight)` and regresses the two
halves at different rates, because volume is sticky and efficiency is noise:

- Volume stats — attempts, carries, targets — modeled per game, lightly regressed.
- Rate stats — completions/att, yards/att, TDs/att, yards/target, receptions/target, TDs/target —
  modeled per opportunity, regressed hard.
- Shrinkage constant `k = within-player variance / between-player variance`, estimated **per
  (position, stat) from the project's own nflverse data**, not imported rules of thumb. `k` is the
  observation count at which a player is exactly half-regressed — the empirical-Bayes form of a
  baseball stabilization point.
- 24-game lookback, 10-game recency half-life, `MIN_K = 1.0` floor.

**v1 positional** (`model/models/v1_positional.py`, 356 lines) covers kickers, IDP and team defenses,
so IDP leagues resolve.

**v2 — matchup** (`model/models/v2_matchup.py`, 208 lines). **Built, measured, declined.** From
`33d19ce`, walk-forward over 2024–25, 10,979 player-weeks:

```
v1-usage      MAE 4.568
weight 0.35   MAE 4.564   (+0.09%)
weight 0.70   MAE 4.570   (worse)
weight 1.00   MAE 4.578   (worse)
```

The sweep is the finding. A real signal applied more strongly helps more; this one degrades
monotonically, which is the signature of a variable with almost no predictive content. The module is
retained and left unwired so the negative result is not silently repeated.

**This bears directly on the brief.** Sections 14, 15 and 51–53 ask for a large defensive and matchup
apparatus feeding the projection. The evidence already in this repo says the naive form of that idea
makes projections *worse*. That does not mean matchup is worthless — it means the version that works,
if one exists, has to act on **usage allocation** rather than on the point estimate. See §13.

**Spread calibration** (`model/backtest/calibration.py`, `artifacts/spread-calibration.json`).
Cross-sectional spread is far too wide for one player's week because it includes the star-to-backup
gap. Calibration measured real forecast error and produced per-position multipliers; without them the
model is under-confident, its 80% intervals capture ~90% of outcomes, and every probability built on
top is blurred.

**Feature store** (`model/features/store.py`) with an `AsOf(season, week)` discipline — queries are
"what did we know before week N?" `model/backtest/harness.py` runs walk-forward evaluation.

**Simulation** (`packages/core/src/sim/`, 634 lines in `season.ts` alone): bipartite lineup solver
over eligible slots, correlated sampling (`correlated.ts`), seeded PRNG (`random.ts`), season and
playoff bracket. `client-sim.ts` (379 lines) runs what-ifs in the browser.

**Decision layer** (`packages/core/src/decisions/`): `evaluateTrade`, `findTrades` with a
`TradeObjective` of `winNow | balanced | rebuild`, `compareStartSit`, `rankForSlot`, `rankWaivers`
with `suggestBid`, `rankPartners`, `offerCandidates`, `oddsDelta`. Plus `valuation/picks.ts` and
`metrics/marginal-value.ts`, `metrics/efficiency.ts`.

**The decision engine the brief asks for in §27 largely exists in `packages/core`.** What is missing
is not the math but the surfacing.

---

## 7. Current formulas

| Quantity | Where | How it is computed |
|---|---|---|
| Weekly stat line | `v1_usage.project_stat_lines` | EB-shrunk volume × EB-shrunk rate, recency-weighted, 24-game lookback |
| Shrinkage `k` | `v1_usage.estimate_shrinkage` | within-variance ÷ between-variance per (position, stat), floored at 1.0 |
| Fantasy points | `core/projections/scoring.ts` | `scoreStatLine(stats, leagueRules)` — per league, at render time |
| Forecast spread | `v1_usage` + `spread-calibration.json` | residual SD × measured per-position multiplier |
| Availability | `core/projections/availability.ts` | injury designation and bye → `{mean, sd, playProbability}` |
| Bye | `export_projections.py:120` | **`active = bool(games.get(team))`** — see §9.4 |
| Game loading | `export_projections.py:29-32` | hardcoded per-position constants (QB .45, RB .30, WR .40, TE .35) |
| Season odds | `core/sim/season.ts` | Monte Carlo over correlated weekly draws + bracket |
| Trade verdict | `core/decisions/trades.ts` | Δ market value + Δ championship probability, fairness band |
| Waiver bid | `core/decisions/waivers.ts` | Kelly-style sizing from Δ playoff odds |
| Dynasty value | `apps/web/src/lib/dynasty.ts` (353 lines) | blend of market value and projection, age-adjusted |
| Pick value | `core/valuation/picks.ts` | market chart + own simulated finish |

The `GAME_LOADING` constants are the clearest example of an un-validated number in the shipping path:
they set how much of a player's variance is attributed to the game environment, they drive
correlation in the simulator, and they were chosen rather than measured.

---

## 8. Current UI architecture

Next.js App Router, server components throughout, one client island per interactive widget
(`TradeBuilder`, `WaiverBoard`, `LineupBoard`, `ThemeToggle`, `LeagueSwitcher`).

Auth is a Sleeper username in a cookie (`lib/session.ts`) — Sleeper league data is public, so there
is no password to hold and nothing is written back. Reasonable for a personal tool.

Charts are hand-built SVG primitives (`components/charts/primitives.tsx`, 809 lines — the largest
file in the app). No charting library. Light default with a dark toggle (`ade1e1e`).

**Ten routes, organized by data type**: index, lineup, roster, power, dynasty, trades, waivers,
schedule, scheme, usage.

Recent commits show the design instincts the brief asks for already emerging — `c54181e` "Say what
the numbers mean before showing them", `27d3838` "State the week and the wire, not just chart them",
`5b1f611` "Put the scheme read next to the start/sit call it bears on". The 538 headline→
explanation→visualization ordering is being applied by hand, page by page, without a shared
component vocabulary to carry it.

**What the UI does not have:** any insight component, any "why?" decomposition surface, any
confidence display, any data-freshness indicator, any refresh control, any player detail page, any
team detail page, any scenario controls, any comparison view, any drill-down panel. The right-hand
explanation rail the brief describes in §62 and §86 does not exist.

**There is no player page.** For a product whose central question is "should I believe in this
player," that is the largest single UI gap.

---

## 9. Current problems

### 9.1 Rookies get no projection — the central defect

**Verified, with the mechanism located.**

```
Fernando Mendoza   sleeper=13269   in crosswalk ✅   projected=False
Jeremiyah Love     sleeper=13287   in crosswalk ✅   projected=False
Carnell Tate       sleeper=13279   in crosswalk ✅   projected=False
Jordyn Tyson       sleeper=13281   in crosswalk ✅   projected=False
Ja'Marr Chase      sleeper=7564    in crosswalk ✅   projected=True
Bijan Robinson     sleeper=9509    in crosswalk ✅   projected=True
```

The artifact holds 2,313 players. The crosswalk holds 7,983. The gap is not identity resolution — it
is that `v1_usage.project_stat_lines` builds every projection from `player_stats` history via the
feature store. A player with zero NFL games has no history rows, so no group forms, so **no row is
emitted at all**. Not a zero projection — an absent one.

The consequence propagates exactly as the brief describes in §19. `apps/web/src/lib/players.ts`
carries a `projected: boolean` flag and the UI renders unprojected players as bare names. So the 1.01
pick sits on a dynasty roster as a name with no value, no ranking, no dynasty curve and no trade
price — in the league type where rookie valuation is most of the game.

The repo is aware of this. `apps/web/src/lib/crosswalk.ts:8` says so in a comment: *"a 2026 rookie
with no NFL snaps... still has to render as a name rather than a numeric id."* The workaround was
built; the model gap was not closed.

**What is missing is a rookie prior.** All of its inputs are already in the lake: `draft_picks`
(257 rows for 2026, with round, pick, team), `combine` (athletic profile), `weekly_rosters` (team,
position, depth), `depth_charts` (442,872 rows for 2026), `schedules`.

### 9.2 The refresh loop has never run

Documented in §4. Cron produces no commits; artifacts are hand-committed; no on-demand path exists;
nothing records refresh state. This is the root cause of every staleness symptom in the brief.

### 9.3 There is no canonical database

Serving reads `model/artifacts/*.json` from the deployment bundle. The 1.7 MB crosswalk and 1.0 MB
projection artifact are parsed into per-process memory and memoized. That works at three leagues and
will not survive multi-week per-player history, feature storage, model versioning, refresh logs, or
any query that is not "give me everything."

Postgres holds only three snapshot tables. The pipeline the brief specifies in §36 —
providers → normalization → canonical DB → features → models → projections → decisions → UI — has
its middle removed: there is no canonical layer between ingestion and serving.

### 9.4 Bye weeks are derived from the wrong signal

`model/export_projections.py:120`:

```python
"active": bool(games.get(team)),
```

`games` is the schedule index **for the single exported week**. So `active` means "this team plays in
week N," which is then reused as an availability flag for every remaining week by
`apps/web/src/lib/projections.ts:112` (`const onBye = !player.active`) and `buildPool`, which reuses
the latest week's projection for all future weeks.

Two symmetric errors follow:

- A player whose bye falls in the exported week is treated as **absent for the rest of the season** —
  zeroed by `availability.ts:69` in every simulated week.
- Every other player is treated as **playing all 14 weeks**, so for one week in fourteen the
  simulation starts a player who is not playing, and the lineup page recommends starting him.

`model/export_byes.py` (77 lines, untracked, never run) correctly derives byes from the full schedule
— a team plays every week but one — but nothing produces its artifact and nothing on the TypeScript
side reads it. The producer is written; the consumer does not exist.

### 9.5 Un-validated constants in the shipping path

`GAME_LOADING` (§7) sets per-position environment variance share and drives simulator correlation.
Chosen, not measured. In a codebase that measured its shrinkage constants and declined to ship an
unvalidated matchup adjustment, this is the conspicuous exception.

### 9.6 The decision layer is under-surfaced

`packages/core/src/decisions/` implements trade evaluation, a trade finder with objectives, start/sit
comparison, waiver ranking with Kelly bids, and partner fit. The UI exposes a fraction of it, and the
pages are named after data (`usage`, `scheme`, `power`) rather than after decisions.

### 9.7 No model explainability surface

Nothing stores per-feature contributions. `v1_usage` computes a shrunk volume and a shrunk rate per
stat and multiplies them — the decomposition the brief wants in §31 and §50 is *computable* from the
existing model, but it is discarded at export time. The artifact keeps `stats`, `sd`, `gameLoading`,
`active` and nothing about how the numbers were reached.

### 9.8 No accuracy record worth the name

511 projection snapshots is roughly one partial week. The `projection_snapshots` design is right; it
has simply not been fed, because the job that feeds it (§9.2) has never run.

### 9.9 Yahoo is built but dark

`packages/adapters/src/yahoo/` is complete with OAuth2 and token refresh, credentials are in
`.env.local`, and the live app shows three Sleeper leagues and no Yahoo league.

### 9.10 Operational gaps

No error boundaries beyond Next defaults. Loading states are two generic `loading.tsx` files. No
data-quality validation of any kind — nothing checks for missing players, duplicate rows, stale
sources, wrong teams, or malformed provider responses. Bad data propagates silently.

---

## 10. Missing data

| Needed for | Missing | Available? |
|---|---|---|
| §17 weather | temperature, wind, precipitation, surface, roof | **No provider.** Roof/surface are in `schedules`. |
| §12 usage | route participation, TPRR, aDOT, air-yard share, first-read targets | **On disk, unused** — `ftn_charting`, `pbp_participation`, NGS |
| §13 offense | pace, PROE, neutral pass rate, red-zone tendency | **Derivable from `pbp`, not derived** |
| §14 defense | coverage shell, man/zone, blitz/pressure rate, box counts | **Partly on disk** (`ftn_charting`, `pbp_participation`); `defense-scheme.json` covers a slice |
| §19 rookies | college production | **Not ingested.** `combine` + `draft_picks` are. |
| §21 aging | position-specific age curves | **Derivable from 2016–2025 `player_stats`, not derived** |
| §18 injuries | historical durations, hazard covariates | `injuries` 2023–2025 on disk, unused for modeling |
| §23 correlation | player-pair covariance | `GAME_LOADING` proxies it with guessed constants |
| §33 backtest | multi-season accuracy record | Harness exists; only 2024–25 exercised |

The recurring pattern: **the data is downloaded and the features are not built.** That is a much
better position than missing data, and it changes the cost of Phases 6–9 substantially.

---

## 11. Missing functionality

Against the brief, by section:

- **§19 rookie model** — absent. The highest-value single gap.
- **§38–40 refresh system, status, force refresh** — absent.
- **§20–21 dynasty valuation, age curves** — partial (`lib/dynasty.ts` blends market and projection);
  no multi-year probabilistic value, no measured age curves.
- **§23 portfolio analysis** — absent. No covariance, concentration, or correlation view.
- **§30/§60 what-if engine** — partial. `client-sim.ts` runs browser sims; no assumption controls.
- **§31/§50 model explanation** — absent.
- **§32/§68 confidence** — computed internally (`sd`, calibration) and never displayed.
- **§47 player page** — absent.
- **§53 team page** — absent.
- **§52 defensive heat maps** — `PositionalHeatmap.tsx` exists; not the multidimensional version.
- **§56 player comparison** — absent.
- **§35 model versioning** — `MODEL_VERSION` is in the artifact; not surfaced, not queryable.
- **§78 data quality validation** — absent.
- **§71–72 error/loading states** — generic.
- **§73 design system** — absent; each page is built independently.

---

## 12. Recommended architecture

Three conflicts exist between this brief and `docs/PLAN.md`. Naming them rather than silently picking:

**Conflict 1 — LLM use.** PLAN.md: "No LLM in the pipeline." Brief §75: Gemini Flash allowed
sparingly for internal use. **Resolution: both, with a hard boundary.** No LLM ever produces a
number, weight, probability or ranking. An LLM may render finished model output into prose, and may
be used offline for text-shaped ingestion where no structured source exists (e.g. parsing beat-writer
role notes into a categorical flag) — with its output stored as data, versioned, and gated by the
backtest like any other feature. Anything an LLM touches is labeled as such in the artifact.

**Conflict 2 — canonical DB vs. artifact files.** The brief wants a canonical database (§36, §80);
the current design serves committed JSON. **Resolution: add the database, keep the artifact seam.**
Postgres becomes the canonical store for identity, features, projections, refresh state and history.
The artifact remains the *serving* format for the hot path, generated from the database rather than
straight from parquet. This preserves the property that makes the system reproducible — Python never
runs in the serving path — while giving the UI something it can query for history, freshness and
explanation.

**Conflict 3 — on-demand refresh vs. weekly git-commit cron.** The current design commits artifacts
to git, which cannot work on demand. **Resolution: retire the git-commit cron.** Refresh writes to
Postgres and object storage, not to the repo. Vercel cron drives the schedule; an authenticated route
drives on-demand. Artifacts stop being version-controlled data and become build outputs.

**Target:**

```
┌─ providers ────────────────────────────────────────────┐
│ nflverse · Sleeper · Yahoo · Odds API · FantasyCalc ·  │
│ DynastyProcess · weather (new)                          │
└──────────────────────┬─────────────────────────────────┘
                       │ each behind a Provider interface
                       │ reporting {attempted, succeeded, counts, errors}
              ┌────────▼────────┐
              │  normalization   │  canonical ids, team codes, validation
              └────────┬────────┘
              ┌────────▼────────────────────────────────┐
              │  canonical store — Postgres + parquet    │
              │  identity · games · weekly stats ·       │
              │  features · projections · components ·   │
              │  refresh_log · model_versions            │
              └────────┬────────────────────────────────┘
              ┌────────▼────────┐
              │ feature store    │  AsOf discipline (exists)
              └────────┬────────┘
              ┌────────▼────────┐
              │ model ladder     │  v0/v1 exist · rookie prior · offense ·
              │ (Python, uv)     │  defense · usage-allocation matchup
              └────────┬────────┘
                       │ versioned artifacts (stat lines + components)
              ┌────────▼────────┐
              │ TypeScript serve │  scoring · sim · decisions (exist)
              └────────┬────────┘
              ┌────────▼────────┐
              │ UI               │  decision-first, with drill-down rail
              └─────────────────┘
```

**Identity, concretely:** introduce an internal `player_uid`. Build it primarily from nflverse
`weekly_rosters`, which already carries eight external ids across 2,930 current players, and use
DynastyProcess as a supplement rather than the sole source. This removes the single-vendor dependency
and makes a player representable without a Sleeper id.

---

## 13. Recommended modeling approach

**Preserve v1 and the harness. Extend, do not rebuild.** v1 is measured, calibrated, and beats the
alternatives that were tried against it. The gates in `model/backtest/` are the most valuable asset
in the repository, and every addition below is subject to them.

**Priority order, by expected value:**

**1. Rookie prior (largest gap, all inputs already on disk).** A hierarchical prior with no NFL
observations: pool by position, then shrink toward a draft-capital curve fit on 2016–2025 rookies
(expected per-game opportunity share as a function of draft slot), adjusted by depth chart position
and team pass rate. As NFL games arrive, the existing empirical-Bayes machinery in `v1_usage` takes
over naturally — the rookie prior is exactly the `prior_mean` a player with `n = 0` should shrink to.
This is the Bayesian structure the brief asks for in §7, and v1 is already built to accept it.

**2. Bye and availability separation.** Split "has a game this week" from "is available." Export the
full-season bye map; make availability a per-week function rather than a per-artifact flag.

**3. Measured `GAME_LOADING`.** Replace the guessed constants with the variance share actually
attributable to game environment, estimated from `pbp` and team totals. This improves simulator
correlation, which improves every probability the product quotes.

**4. Age curves.** Position-specific, fit on 2016–2025, conditioned on career workload. Feeds dynasty
directly (§21) and is a prerequisite for honest multi-year valuation.

**5. Offense model.** Pace, PROE, neutral and red-zone tendencies from `pbp`. This is upstream of
every player's volume and is the thing the brief is right that no other tool does honestly.

**6. Matchup, retried the right way.** The measured failure in `33d19ce` is informative: scaling a
point estimate by opponent strength does not work. The version worth testing acts on **allocation**
— a compositional (softmax) target-share model with matchup covariates, so shares sum to one and team
attempts come from the game simulation rather than from the adjustment. Same gate; report the result
either way.

**7. Defensive fingerprint.** Multidimensional as §14 asks, built from `ftn_charting` and
`pbp_participation`, opponent-adjusted. Ship it as *display* first — where the evidence already
supports it — and only into the mean if it clears the harness.

**8. Injury hazard model.** From `injuries` 2023–2025 plus usage covariates. Feeds play probability
and dynasty risk.

**Stated honestly:** the brief's §5 asks that established methods be researched rather than invented.
v1 already does this — empirical-Bayes stabilization is Marcel's core idea, applied correctly. The
danger in this project is not insufficient sophistication; it is adding sophistication that the
harness will show does not help, and shipping it anyway because it was expensive to build. The v2
result is the template for how to handle that.

---

## 14. Recommended UI architecture

**Build the design system before the pages** (§73). The recent commits show the right instincts
applied one page at a time; a shared vocabulary is what turns that into a product.

Primitives, in order: `Insight` (category / headline / importance / evidence / recommendation /
explore), `Why` (component decomposition, waterfall), `Confidence`, `Distribution`, `PercentileBar`,
`Freshness`, `DrillRail` (the right-hand panel of §62/§86), `DataTable` (sortable, sticky, tabular
numerals), `Sparkline`, `Heatmap`.

**Reorganize routes around decisions, not data types:**

| Route | Question |
|---|---|
| `/league/[id]` | How good is my team, and what matters right now? |
| `/league/[id]/lineup` | Who do I start? |
| `/league/[id]/trades` | Should I make this trade? |
| `/league/[id]/waivers` | Who do I add, for how much? |
| `/league/[id]/dynasty` | What is my roster worth over five years? |
| `/player/[id]` | **(new)** Should I believe in him? |
| `/team/[abbr]` | **(new)** Why does this offense produce what it does? |
| `/league/[id]/research` | Why does the model believe this? |
| `/data` | **(new)** What does the model know, and how fresh is it? |

The existing `usage`, `scheme`, `power` and `schedule` pages become drill-down destinations reached
from an insight rather than top-level navigation.

**Non-negotiables from the brief:** no card-per-statistic (§74); every number carries context (§67);
uncertainty always visible; drill-down into the right rail on desktop and a bottom sheet on mobile;
freshness always on screen.

---

## 15. Recommended implementation order

Ordered by (user pain × unblocking power) ÷ cost, reconciled with the brief's phase list.

**A. Rookie prior + bye correction.** Closes the brief's §19 and §9.4 here. All inputs on disk. Makes
every dynasty page correct for the first time. *Brief phases 3, 5.*

**B. Refresh system.** Provider interface reporting attempt/success/counts/errors; `data_sources` and
`refresh_log` tables; an authenticated refresh route; Vercel cron replacing the git-commit workflow;
freshness surfaced in the UI. *Brief phases 3, and §38–40.*

**C. Canonical identity and store.** `player_uid` built from `weekly_rosters` first; canonical tables;
artifacts generated from the database. *Brief phase 2.*

**D. Feature layer.** Age curves, offense (pace/PROE/red zone), defensive fingerprint, usage features
from FTN and participation. *Brief phases 4, 6, 7.*

**E. Explainability.** Persist projection components at export; `Why` surface. *Brief §31, §50, §76.*

**F. Design system, then decision-first UI.** *Brief phase 18.*

**G. Portfolio, scenario engine, comparison, player and team pages.** *Brief phases 13, 17.*

**H. Matchup retry, injury hazard, ensemble.** Each gated by the harness. *Brief phases 8, 34.*

**I. Backtest expansion and calibration reporting.** *Brief phase 19.*

Steps A and B are deliberately first: they are the two the user named as pain, they are the cheapest
relative to their effect, and every model improvement downstream is worthless while the data feeding
it is four days stale and the 1.01 pick has no value.

---

## Appendix — reproducing the key findings

```bash
# Rookies resolve in the crosswalk but have no projection
uv run --project model python -c "
import json; from pathlib import Path
cw=json.loads(Path('model/artifacts/crosswalk.json').read_text())['by_sleeper_id']
pr=json.loads(Path('model/artifacts/projections-2026-01.json').read_text())['players']
n={e['name'].lower():e for e in cw.values()}
for x in ['fernando mendoza','jeremiyah love','carnell tate','ja\'marr chase']:
    e=n[x]; print(x, e['sleeper_id'], e['sleeper_id'] in pr)"

# The weekly refresh has never committed
git log --all --oneline --grep='Weekly projections refresh'

# Supabase row counts
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/projection_snapshots?select=id" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Prefer: count=exact" -H "Range: 0-0" -D - -o /dev/null
```

---

## Work completed since this audit

Ordered as §15 recommended. Every claim here was verified by running the thing,
not by reading the code that was just written.

### A1 — Rookies now project (§9.1, §19)

**`model/models/rookie_prior.py` (new).** A hierarchical prior for players with
no NFL history: expected rookie-year opportunity fitted against draft slot over
ten completed classes, adjusted by depth-chart rank, with rates drawn from the
rookie population rather than the whole league. It is the missing half of a
statement v1 already made — `_shrink(total, n, prior_mean, k)` with `n = 0`
returns `prior_mean`, and v1's prior was the positional average, which flatters
a seventh-rounder and badly undersells the first pick of the draft. As real
games arrive v1 takes over on its own; nothing switches.

**It cleared the gate**, which is the repository's own rule. Walk-forward over
the 2024–25 classes, 1,676 rookie player-weeks
(`model/backtest/run_rookie_gate.py`):

```
replacement    MAE 6.255   RMSE 9.459   CRPS 5.079
flat-rookie    MAE 5.443   RMSE 6.884   CRPS 3.787
draft-prior    MAE 4.535   RMSE 6.189   CRPS 3.390

draft-prior vs flat-rookie: MAE skill +16.67%
```

`replacement` is what the app did — no row, which reads as zero. `flat-rookie`
is the honest baseline: same players, same spread, same scoring, with only draft
slot and depth chart removed. CRPS falls alongside MAE, so the distribution
improved rather than the mean being sharpened at the cost of calibration. For
scale, v1 scores MAE 4.568 on veteran weeks.

**Result:** artifact went from 2,313 to 2,516 players, 203 of them rookie
priors. Verified in the running application — Carnell Tate now renders with a
projection on the roster and dynasty pages, and the 2026 class appears on the
waiver wire.

Three findings surfaced while building it, each fixed:

- **nflverse gives the current draft class PFR-style ids** (`MEN516487`), not
  gsis — 0 of 257 rows for 2026. Joining on that column silently yields nothing.
  Training joins on gsis (correct for finished classes); the current class joins
  to `weekly_rosters` by normalized name, which is the only place its gsis
  exists before a player has played.
- **`FeatureStore.as_of` is wrong for rosters and depth charts.** It truncates
  the in-flight season to *completed* weeks, which is right for anything
  measured from a game and wrong for a forward-looking document. At
  `AsOf(2026, 1)` the last completed week is 0, so the entire current season was
  discarded — every rookie vanished, and every veteran who changed teams in
  March was exported with **last season's team**. That second bug was live and
  unrelated to rookies. `current_rosters` fixes both.
- **nflverse changed the depth-chart schema mid-stream**: 2024–25 carry
  `season`/`week`, 2026 carries `dt`. Unioned by name, each is null in the
  other's rows, so reading either alone returns an empty join with no error —
  the depth adjustment appeared to be applied while doing nothing.

Two calibration corrections, both caught by measurement rather than review: the
log-log curve extrapolated to 64 carries a game for a first-overall back
(capped at what top-ten picks actually average, 15.7); and the depth multiplier
was applied *after* the cap, compounding past it. Depth multipliers are
constrained non-increasing, because being listed deeper cannot earn more work.

### A2 — Bye weeks (§9.4)

`active` meant "this team has a game in the one exported week", and the pool
reuses that week for the rest of the season, so it was a fact about one week
applied to fourteen. Fixed at both ends: the export now writes a per-team
`byeWeek` from the full schedule (32 teams; the only nulls left are free
agents), `active` means "on an NFL roster", and `buildPool` gives each week its
own availability as a small overlay on a shared baseline rather than a full
copy.

`isOnBye` / `isPlayingIn` were added because changing `active`'s meaning
silently changed **eleven call sites** that used it to mean "playing this
week" — the lineup board, waivers, trades, roster analysis and league analytics
among them. All were updated to pass a week. Covered by
`apps/web/src/lib/projections.test.ts` (7 tests).

### A3 — Team identity (§5, §78)

Three sources spell teams differently — schedules `ARI`, rosters `AZ`,
DynastyProcess `GBP`/`KAN`/`NOR`/`LVR` — and nothing errored when they failed to
match; a lookup just returned nothing. That is why 367 players initially had a
null bye. `canonical_team` reconciles all three to the schedule's spelling,
including relocations.

### B — Refresh system (§9.2, §38–40)

- **`supabase/migrations/0003_data_freshness.sql`** — `data_sources` (current
  state, per-provider staleness thresholds), `refresh_runs` (every attempt,
  including failures, which is what a "last updated" timestamp throws away), and
  a `data_freshness` view that decides staleness once so every caller agrees.
  **Not yet applied** — no `psql` or Supabase CLI available here.
- **`packages/ingest/src/refresh.ts`** — `withRefreshTracking` records the
  attempt before the work and the outcome after, failures included. Fail-soft
  throughout: if the store is unreachable, or the migration is not yet applied,
  the refresh still runs and pages still render with freshness reported as
  unknown.
- **`POST /api/refresh`** — a real force refresh, per-source or all. Fails
  closed: with no `CRON_SECRET` it refuses rather than defaulting open, since an
  open endpoint that spends a metered API key is a bill. Returns 207 on partial
  failure. Verified returning 401 unconfigured.
- **`GET /api/data-status`** — verified live, reporting model version and
  artifact age.
- **Vercel cron** daily at 11:00 UTC, replacing the GitHub Action's commit-back
  step. That step wrote artifacts to `main` and **had never once succeeded**;
  the workflow now keeps the pre-kickoff snapshot capture — which genuinely
  belongs on a schedule — and publishes rebuilt artifacts as a downloadable
  artifact instead of force-advancing the default branch.
- **`Freshness` component** in the league header, not a status page nobody
  visits. Names failing providers and their errors.

### A4 — The browser what-if sim (§9.4, second half)

The bye fix had an unwired consumer. `client-sim.ts` rebuilds its own weekly
pool from serialized players and reused one map for every week, so after
`active` was redefined it played everyone all season including their byes — the
server bug arriving from the opposite direction. `byeWeek` is now carried
through `PlayerInfo` → `serialize.ts` → the wire, and both browser pools (rostered
players and free agents) sit a player down in his own bye week. Verified by
rebuilding and loading the trades and waivers pages.

The `active` readers that were **not** changed — `scheme/page.tsx`, `usage.ts`,
`usage/page.tsx`, `static-export.ts`, `analysis.ts`, `positional-strength.ts` —
were reviewed and intentionally left as roster-membership filters, which is what
they meant all along and is now what `active` says.

### E — Model explainability (§31, §50, §76)

The decomposition was already being computed and discarded. Fantasy scoring is
an identity — `Σ(opportunity × rate × weight)` — and v1 evaluates each half
separately before multiplying, then keeps only the product. The export now keeps
three stat lines: every stat at its positional average, the player's volume at
positional rates, and the real projection. Scored per league at serve time, the
two gaps are what his usage and his efficiency are each worth.

```
Ja'Marr Chase    7.1 avg WR   +12.3 opportunity   +0.9 efficiency  = 20.2
Saquon Barkley   7.4 avg RB    +7.8 opportunity   +0.0 efficiency  = 15.1
Drake Maye      13.8 avg QB    +2.1 opportunity   +3.8 efficiency  = 19.6
```

The steps sum to the projection exactly, and `explain.test.ts` fails if they
stop. That property is the whole point: a `Why?` panel that reverse-engineers a
plausible story is worse than none, because it is confident, legible and
unfalsifiable.

Rookies get one bar, not a waterfall — with no history there is no prior line,
so decomposing would drop the whole projection into the last bucket and call it
"efficiency", which is precisely backwards. Confidence is capped to match.

### F — Player page (§47)

The audit called this the largest single UI gap. League-scoped, because none of
the answers are league-independent. Ordered conclusion → why → evidence →
caveats. Roster names link into it.

### G — Aging curves (§21)

Replaces the hand-set table (`QB 34, RB 27, WR 29, TE 30`) with curves fitted by
the **delta method** over 2016–2025: only players appearing in consecutive
seasons contribute, and each is compared to himself, so his level cancels and
the age effect survives. Regressing production on age across a population
measures survivorship instead — the 32-year-olds still playing are the ones good
enough to still be playing.

```
RB  22:0.95  23:1.00  24:0.94  25:0.82  26:0.75  27:0.70  28:0.54  30:0.38
WR  21:0.73  23:1.00  25:0.92  27:0.78  29:0.59  30:0.44  32:0.24
TE  22:0.82  25:1.00  26:0.96  27:0.71  29:0.65  31:0.45
QB  23:0.96  24:1.00  25:0.96  26:0.93  27:0.92
```

Measured decline ages (below 75% of peak) come out **RB 26, WR 28, TE 27**
against the asserted 27, 29 and 30 — tight ends were being valued about three
years too generously.

Quarterbacks are the honest failure: paired seasons run out around 27, before
any real decline, so the curve cannot answer and the asserted 34 stands, marked
with an asterisk in the UI. A number nobody measured should not look like one
somebody did.

### H — Offensive model, served (§13, §53)

`team_context.py` had computed pace and PROE since Phase 4b and nothing had ever
read them except the declined v2 — correct features, invisible. Now exported,
with **red-zone tendency** added, which was the genuinely missing piece: pace
decides how many plays a team runs and PROE how it splits them, but neither says
who gets the ball inside the twenty, where touchdown equity is assigned.

```
ARI  62.9 plays/g  31.8 s/play  PROE +6.6%  neutral .672  RZ pass .692
BAL  56.1 plays/g  32.9 s/play  PROE −7.0%  neutral .526  RZ pass .401
```

Nothing here is opponent-adjusted, deliberately: these are tendencies, and
tendencies are choices. A coach who throws on early downs does so against every
defense, so adjusting for opponent would subtract signal. Surfaced on a new
**team page** and in a section on the player page.

### I — The matchup adjustment, retried and declined again (§14, §15)

v2 adjusted *points* and lost. The obvious objection was that it adjusted the
wrong quantity — v1's own finding is that volume is sticky and efficiency is
noise, so adjusting points means adjusting mostly noise. v3 takes that objection
seriously: same defensive strength estimate, applied to **opportunity** only,
rates untouched.

```
v1-usage    MAE 4.568   CRPS 3.312
v3 w0.25    MAE 4.567   CRPS 3.312   (+0.02%)
v3 w0.50    MAE 4.569   CRPS 3.313   (worse)
v3 w1.00    MAE 4.581   CRPS 3.323   (worse)
```

Same monotone decay. Kept and left unwired alongside v2.

**This is the more informative negative.** Opponent strength does not predict a
fantasy week through points, and it does not predict one through opportunity
either — not at the resolution a season of team-level data can measure. Two
independent attempts, one shape of failure. Anything finer needs charting data
rather than box-score opportunity, and gets the same gate.

This directly answers §14–15 of the brief, which asks for a large matchup
apparatus feeding the projection. The evidence in this repository now says twice
that the version everyone builds does not work. Scheme stays displayed beside a
projection and out of the mean.

### J — Multi-year dynasty value (§20)

Each future season expressed as a share of the player's *current* level rather
than of his position's peak — the distinction that makes two players at
different points on the same curve comparable. Summed over four years it gives
one number in the currency a trade actually turns on: seasons still to come,
priced at what each man is worth today. Undiscounted on purpose, because the
contend-or-rebuild read already makes that judgement explicitly.

### K — Defensive pressure and box tendencies (§14)

`export_defense.py` measures defenses by consequence and argues that is the
better road for coverage. It is — but not for pressure, where a sack is charged
identically whether it came from a four-man rush or an unblocked corner blitz,
and the two predict opposite things. Read from FTN charting (2022–2025, legal at
inference), giving blitz rate, extra-rusher rate, box count and light-box rate.

Blitz rate identifies the league correctly from charting rather than reputation:
MIN .476, TB .407, KC .372 at the top; SF .219 at the bottom.

**Caught before shipping:** ~25% of charted rows carry `n_defense_box = 0`, FTN's
not-charted sentinel. Averaged in, the league mean read 4.89 defenders; treated
as missing it reads 6.18. The wrong number looked entirely plausible, which is
the only kind that survives review.

Coverage shell and man/zone rates — also asked for in §14 — are **not** available:
FTN does not carry them and `pbp_participation` was retired. That is a data
limit, not an oversight.

### L — What-if, portfolio, availability, and one measured open question

**What-if engine (§30, §60).** Sliders that move opportunity through the model's
own identity with rates held fixed. Scaling the finished number instead would
silently scale touchdown rate — the most-regressed quantity in the model, and
precisely the one that does not follow usage.

**Portfolio analysis (§23).** The roster as correlated assets. Tyler's own comes
out stacked: shared games widen its weekly range ~9% beyond what the individual
projections imply. Correlation is structural (game loadings), not a measured
covariance matrix, and the page says so beneath the numbers.

**Injury designations, measured (§18).** `availability.ts` priced them from a
hand-set table. Joining every report since 2016 to who actually appeared:

```
Questionable   n=4,488   play rate 0.593   (was priced 0.72)
Doubtful       n=  529   play rate 0.008   (was priced 0.25)
Out            n=3,232   play rate 0.000   (correct)
```

Doubtful was wrong by a factor of thirty. And the half nobody prices: a
Questionable player who suits up produced **0.774** of his own healthy baseline
over 2,359 appearances. Availability now applies both haircuts.

*Caught before shipping:* the first run reported a production ratio of 1.069 for
Out — implying injured-out players are better. It rested on one row of 3,232.
Play rate and production ratio have completely different effective samples off
the same join; only Questionable clears a reportable threshold.

**`GAME_LOADING` — §9.5 measured, and deliberately not replaced.** Three
estimators, all far below the asserted values. Least self-confounded
(leave-one-out against team-mates): **QB 0.103, RB 0.007, TE 0.001, WR 0.001**
against asserted 0.45/0.30/0.35/0.40.

The constants are wrong, probably by a large factor, and the simulator has been
generating more team correlation than the data supports — which inflates the
variance of a stacked roster and distorts every title probability quoted for
one. But every estimator here correlates one fantasy score against another, so
all of them net the game effect against target competition and cannot separate
them. Swapping in 0.001 would assert a quarterback and his WR1 are independent,
which is certainly false. A correct estimate needs an exogenous game measure —
the Vegas total, or drive-level simulation per `PLAN.md` v3. Recorded with
numbers so the next attempt starts from evidence.

### M — Design system, insights, and a wider backtest

**Shared vocabulary (§73).** `components/design/primitives.tsx`: `Metric` (which
will not compile without context, per §67), `MetricRow`, `PercentileBar`,
`Insight`/`InsightList` (§45). No rounded rectangle in the file, per §74.

**League home now answers its question (§44).** Opens with "What matters right
now", ranked by consequence. Every insight is a threshold applied to a number the
model already computed, with the number quoted so a reader can disagree with the
threshold. Nothing is generated for a quantity the product lacks, and
`recommendation` is optional — inventing an action to fill a slot is how a tool
starts advising things it has no basis for. Data health outranks everything,
because a stale model quietly makes every other line wrong.

**Backtest widened to four seasons (§33).** 10,979 → 21,679 player-weeks:

```
v0-marcel   MAE 4.880        per season    v0      v1
v1-usage    MAE 4.608          2022      4.922   4.677
skill       +5.6%              2023      4.871   4.621
                               2024      4.914   4.613
                               2025      4.814   4.523
```

v1 wins in all four seasons separately. Doubling the window moved the pooled
figure from +6.1% to +5.6% — a real result getting slightly smaller and staying,
which is what a real result does. A single pooled number can hide an edge that
came entirely from one favourable year; this one does not.

### Honest limits

- The migration is unapplied, so `sources` is empty and the panel says so.
- The rookie backtest covers two classes, because `weekly_rosters` only reaches
  back to 2024 in the lake. Re-run as it deepens.
- It measures the projection *given a player appeared*, not the probability he
  appears.
- Refresh covers the serve-time sources only. Projections, the crosswalk and the
  lake are built by the Python pipeline, which by design never runs in the
  serving path; the button reports their age and says plainly that it cannot
  rebuild them.
- `GAME_LOADING` (§9.5) is measured but **not replaced** — see §L. The measured
  values are too confounded to wire in, and the asserted ones are too high.
  This is the most consequential open item in the model.
- The aging curves are a **floor on decline**: the delta method still conditions
  on surviving into the second season, so real cohorts fall off faster.
- The QB curve cannot reach the ages that matter for quarterbacks.
- Multi-year value is a point estimate scaled by the aging curve, not a
  probabilistic distribution as §20 asks.
- Coverage shell and man/zone rates are unavailable from any ingested source.
- The availability haircut is a *mid-week* number. Before inactives drop it is
  right; by Sunday morning, when you often know a Questionable player is active,
  it is too harsh — 9.2 against 15.5 on a 20-point player. The app has no
  kickoff-relative timestamp, so it assumes mid-week and errs toward benching a
  hurt player. Safer direction, but a direction.
- The what-if engine is player-level; there is no roster-level scenario ("what
  if my QB goes down") yet.
- The design system exists but only the home, player and team pages are built on
  it; the older pages still carry their own shapes.
- Still unbuilt: the canonical database, the remaining page migrations onto the
  design system, and a formal performance pass. A league page currently builds in
  roughly 2s with 2,000 simulations.
