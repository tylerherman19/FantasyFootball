# Fantasy Football Edge — Build Plan

Repo: `github.com/tylerherman19/FantasyFootball` (currently empty)

## Context

Two existing tools each solve half the problem, and neither connects the halves:

- **My Fantasy Analyzer** has a good simulation engine (measured per-position variance, bipartite lineup solver, injury modeling, 10k seeded Monte Carlo) running on borrowed inputs — unmodified Sleeper projections and third-party trade values — with no correlation between players, no memory, and no accuracy tracking.
- **Dynasty Daddy** has the data (own trade values from millions of real trades, own ADP, crowd rostership, blended rest-of-season ranks, six platforms) but its playoff odds are `0.5 + (rating gap × 0.3)` clamped to [0.2, 0.8], coin-flipped 1,000 times. No simulated scores at all.

**Thesis:** one system where every decision — start/sit, waiver claim, trade, rebuild-or-contend — is priced in the same two currencies: **market value** (what an asset is worth) and **championship probability added** (what it does for *you*). Underneath it, a genuine projection engine built from historical data, not a repackaging of someone else's numbers.

**Confirmed scope:** personal tool first (no public accounts, but schema is league-scoped so multi-user is an addition, not a rewrite). Vegas lines via free-tier key. Two Sleeper leagues + one Yahoo league, kept separate throughout the UI. Dynasty, keeper, and redraft.

**Non-goals:** daily games, trivia, articles, social feeds, ads.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 15 (App Router) + TypeScript strict | Your existing stack; Vercel-native |
| Hosting | Vercel | Cron for ingest, edge caching |
| DB | Supabase Postgres | Snapshots, values history, accuracy records |
| Analytics store | DuckDB + Parquet (local + object storage) | Columnar historical data; Postgres is the wrong shape for 25 seasons of play-by-play |
| **Modeling** | **Python 3.12 via `uv`, offline only** | Real modeling needs polars/duckdb/scikit-learn/LightGBM. `uv` sidesteps the stale system 3.9 entirely |
| **Serving** | **TypeScript** | Python trains and exports versioned artifacts (coefficients, shrinkage constants, residual pools) as JSON/parquet; the TS sim consumes them. **Python never runs in the serving path.** |
| Interactive compute | Web Worker in browser | Fast what-ifs, no server cost |
| UI | Tailwind + shadcn/ui, Recharts | |
| Tests | Vitest (engine), pytest (models), Playwright (one smoke path) | |

---

## Repo layout

```
/apps/web                  Next.js app
/packages/core             pure TS, zero deps — inference + simulation
  /domain                  League, Roster, Player, Matchup (platform-neutral)
  /projections             artifact loading, inference, blending
  /sim                     lineup solver, correlated sampling, season + bracket MC
  /valuation               market values, pick values, VORP/WAR
  /decisions               trade eval, trade finder, waivers, start/sit
  /metrics                 luck, efficiency, leverage, scarcity, age curves
/packages/adapters         SleeperAdapter, YahooAdapter (PlatformAdapter interface)
/packages/ingest           nflverse, FantasyCalc, DynastyProcess, Odds API loaders
/model                     Python: feature store, training, backtesting, artifact export
  /features                point-in-time feature builders
  /models                  v0…v4 ladder
  /backtest                harness, scoring rules, calibration
  /artifacts               versioned exported model outputs (committed)
/supabase/migrations
```

`packages/core` never imports a platform SDK, `fetch`, or React — numbers in, numbers out. That is what makes it testable and backtestable.

---

## Data

| Source | What we take | Access |
|---|---|---|
| [nflverse-data](https://github.com/nflverse/nflverse-data/releases) | play-by-play, weekly player stats, snap counts, depth charts, rosters, schedules, injuries, **Next Gen Stats**, **FTN charting**, participation, combine | Free CSV/parquet, GitHub releases |
| Sleeper API | leagues, rosters, matchups, transactions, traded picks, drafts, players, trending add/drop | Public, no key |
| Yahoo Fantasy API | leagues, rosters, matchups, transactions, `percent_owned` | OAuth2 — **needs your dev app** |
| The Odds API | NFL totals + spreads (de-vigged) | Free tier — **needs your key** |
| [FantasyCalc](https://api.fantasycalc.com/values/current) | dynasty + redraft values, ADP, roster %, trade frequency | Public JSON, verified working |
| [DynastyProcess data](https://github.com/dynastyprocess/data) | `values.csv`, player ID crosswalk | Open data |

**Training window: 2016+** (Next Gen Stats era), recency-weighted. Play-by-play goes back to 1999, but the game changed; we don't ingest 25 years just because it exists.

**Rostership honesty:** Dynasty Daddy's rostership works because of 2.7M ingested leagues. We'll have ~5. We source the same signal legitimately — Yahoo `percent_owned`, Sleeper trending add/drop, FantasyCalc roster % — and build our own only once volume exists. Not a launch feature.

Everything is reimplemented from concepts. MFA's bundles are minified proprietary code; Dynasty Daddy's license is unverified. We take ideas, not code.

---

## What we're stealing, and from whom

| Industry | Technique | Where it lands |
|---|---|---|
| Baseball (PECOTA/ZiPS/Marcel) | Stat-specific **stabilization points**, aging curves, comparable-player similarity, separating skill from luck | v0/v1 shrinkage; rookie priors; TD-rate regression |
| Weather forecasting | Ensemble forecasting, **CRPS** scoring, model-output-statistics bias correction, calibration as a first-class metric | Backtest harness; recalibration layer |
| Election forecasting (538/Economist) | Hierarchical partial pooling of sources, **house effects** (each source's measured systematic bias), uncertainty widening with horizon, correlated errors | Source blending; per-source bias correction |
| 538 specifically | QB-adjusted Elo, published methodology, uncertainty shown as fans/bands rather than hidden, "how much did this one game matter" | Team strength; leverage metric; **the entire visual language** (see UI section) |
| Quant finance | Factor models, **covariance shrinkage** (Ledoit–Wolf), point-in-time backtesting discipline, mark-to-market vs. fundamental value | Correlation matrix; buy-low/sell-high signal |
| Finance (Kelly criterion) | Bet sizing proportional to edge and bankroll | **FAAB bid sizing** |
| Actuarial / insurance | Hazard models with covariates, survival analysis, credibility theory | Injury model; empirical-Bayes shrinkage |
| Sports betting markets | De-vigging, closing-line value as ground truth | Vegas priors; "did our valuation beat the market's later valuation?" |
| Chess ratings | Glicko (rating **plus uncertainty**) rather than plain Elo | Team strength with confidence intervals |

---

## The modeling ladder

The engine is built as versions, each gated on beating the previous one **out of sample**. This is the honest definition of "top tier": not a pile of techniques, but a measured improvement at every step.

**v0 — Marcel baseline.** Recency-weighted multi-season average, regressed to positional mean, age-adjusted. Deliberately dumb. It exists to be the number every later version must beat, and it is famously hard to beat by much.

**v1 — Opportunity × efficiency decomposition.** The core structural model. Fantasy points are an identity: `Σ (opportunities × efficiency × scoring weight)`. Model the pieces separately, because they have wildly different persistence:
- *Volume is sticky:* snap share, route participation, target share, carry share, red-zone share.
- *Efficiency is noisy:* yards per target/carry, catch rate.
- *Touchdown rate is nearly pure noise* over small samples and gets regressed hardest.
- Shrinkage per stat via **empirical Bayes with stabilization points computed from our own nflverse data** — a player with 50 red-zone carries barely gets regressed; one with 8 gets pulled almost all the way to baseline. Closed-form; no MCMC needed.
- Rookies and low-sample players shrink toward priors built from draft capital, athletic profile, and comparable-player histories.

**v2 — State-space weekly updating.** A player's true role and talent is a latent state that drifts over a season; each game is a noisy observation of it. Kalman-style updating gives principled in-season learning instead of naive rolling averages — the same data-assimilation idea weather models use. Handles "did his role actually change, or was that one loud game?"

**v3 — Game simulation and correlation.** Simulate the football game, not the box score: Vegas total and spread as a prior on team scoring, drive-level simulation with score-dependent play calling. Volume then falls out of game script endogenously, and correlation is generated rather than assumed — QB and his WR1 rise together, a blowout suppresses passing, a shootout lifts both sides. Residual correlation calibrated against the empirical joint distribution from play-by-play, with covariance shrinkage.

**v4 — Ensemble and recalibration.** Stack the structural model with the market (Vegas), consensus sources (Sleeper, ADP-implied), and a gradient-boosted residual model. Weights learned by out-of-sample log score, with per-source house-effect corrections. Then an isotonic recalibration layer so stated confidence matches observed frequency.

Output at every level is a **full predictive distribution**, not a point estimate: probability the player is active, usage distribution given active, efficiency distribution given usage. That is what the simulator actually needs.

**Dependency discipline:** start with polars/duckdb + scikit-learn/LightGBM. Graduate to PyMC/numpyro only if the harness shows headroom at v2+.

### Defensive scheme, and how its effects propagate through an offense

Most tools apply a matchup adjustment player-by-player, which double-counts and quietly breaks arithmetic: eleven players can't each gain 8% of the targets. We model the defense's effect on the **offense as a system**, then let it flow downhill.

**1. Characterize the defense (features from play-by-play, Next Gen Stats, FTN charting):** pressure rate and blitz rate, coverage shell (two-high vs. single-high), man vs. zone rate, light-box vs. heavy-box rate, and whether their top corner travels. Each is opponent-adjusted with a ridge/mixed model, so we're measuring the defense and not the schedule it happened to face — a unit that played four bad offenses looks elite until you correct for it.

**2. Apply it to the quarterback first**, because he's the valve everything else runs through:
- Pressure and blitz rate → sack rate, interception rate, and *variance* (blitz-heavy defenses produce both more disasters and more explosives).
- Two-high shells → compressed average depth of target, more underneath completions, fewer deep shots, and more scramble rushing yards.
- Man coverage → more contested targets concentrated on the primary receiver; zone → targets spread wider across the formation.

**3. Propagate to the pass catchers as a change in the *allocation*, not the total.** Target shares are modeled compositionally — a softmax over players with matchup covariates — so the shares always sum to one and the team's total pass attempts come from the game simulation, not from the matchup adjustment. Concretely: a defense that compresses depth of target shifts share away from the perimeter deep threat and toward the slot receiver, tight end, and pass-catching back. A shadow corner suppresses the alpha receiver specifically and redistributes to everyone else — which is precisely the case where naive "team allows the 5th-most points to WRs" gets it backwards.

**4. Running backs get it from two directions.** Directly through box counts (light boxes, a consequence of two-high shells, raise rushing efficiency; heavy boxes lower it), and indirectly through game script — a defense that stops the run and builds a lead converts carries into pass attempts, which changes both the RB's touch mix and everyone's volume. Because volume already comes out of the drive-level game simulation in v3, this happens endogenously instead of being bolted on.

**5. Shrink it hard, and gate it.** Real scheme effects are small relative to the noise, and public matchup adjustments are the single most overfit thing in fantasy analysis. Every scheme coefficient goes through the same empirical-Bayes shrinkage as everything else, and the whole module has to beat the no-matchup-adjustment model out of sample or it does not ship. If it turns out matchup adjustments are worth less than the internet believes, the harness will say so and we'll report that honestly — which is itself information you can't get anywhere else.

---

## The self-correcting loop

Three automated feedback loops, running continuously:

1. **Weekly state updating (v2)** — each player's role and talent is a latent state that drifts; every game is a noisy observation that updates it. Role changes are detected in weeks, not months, and one loud game doesn't move the estimate much.
2. **Error-driven correction** — every projection is snapshotted before kickoff, then scored after. Each source's systematic bias (its "house effect") is measured and corrected automatically; blend weights are re-fit on rolling out-of-sample performance. No hand-tuning.
3. **Recalibration** — if the simulator says 70% and those events happen 62% of the time, an isotonic layer corrects the mapping until stated confidence matches observed frequency. Retrained on schedule.

What this is *not*: self-modifying architecture. Ladder versions (v1→v2→v3) are built deliberately and shipped only if the harness says they beat the previous rung. The continuous part is parameters, weights, and calibration — which is the part that actually matters.

**No LLM in the pipeline.** Numeric forecasting is where language models are weakest, and one would make results non-reproducible. No Gemini/Spark/OpenAI dependency. The optional exception is plain-English narration of finished numbers ("your title odds fell because Nacua's route share compressed"), which would use the Claude API and is strictly cosmetic.

---

## Point-in-time correctness — the hard problem

The models are known math. The thing that silently kills projects like this is **lookahead leakage**: training on information that wasn't knowable at kickoff, producing a backtest that looks brilliant and a live model that doesn't work.

So the feature store splits every feature into:
- **Serve-time safe** — weekly stats, snap counts, play-by-play, injury reports, depth charts, odds. Stored as per-week records with an as-of timestamp; queries are always "what did we know before week N?"
- **Train-time only** — anything that arrives late. Concrete trap: **FTN participation data (route participation, TPRR) is only published after the season ends.** It's legitimate for computing stabilization constants and studying which signals matter; it is *not* available as an in-season input. Using it at inference would build training/serving skew directly into v1.

Every model is trained and evaluated walk-forward: fit on weeks up to N, predict N+1, never peek. Nested cross-validation for hyperparameters.

---

## Phases

Each phase ends with something usable. Sleeper-only until Phase 9.

**Phase 0 — Scaffold.** Monorepo, TS strict, Vitest, uv-managed Python, ESLint/Prettier, GitHub Actions CI, `.env.example`, `.gitignore` covering all keys before the first commit. Supabase + Vercel linked.

**Phase 1 — Sleeper adapter + domain model.** `PlatformAdapter` interface defined now so Yahoo drops in later. Player ID crosswalk (DynastyProcess). League/roster/matchup/transaction ingest. League-type detection: dynasty/keeper/redraft, SuperFlex, scoring rules, median-wins.
→ *All 5 leagues loaded and queryable.*

**Phase 2 — Historical data lake + point-in-time feature store.** nflverse ingest 2016+ into Parquet/DuckDB. As-of-timestamped feature tables. Train/serve feature split enforced in code, not convention.
→ *Every feature answerable as "what did we know before week N?"*

**Phase 3 — Backtest harness (the ruler, built before the models).** Walk-forward evaluation, proper scoring rules (CRPS for distributions, log score, MAE for point estimates), reliability diagrams, per-position and per-week breakdowns. Baselines wired in: Sleeper's projections, FantasyPros consensus where available, v0.
→ *We can measure any model against the incumbents before writing one.*

**Phase 4 — Projection engine v0 → v4.** The ladder above, each version gated on beating the last out-of-sample. Ship the best passing version; keep the artifact versioned so results are reproducible.
→ *Own projections, measurably better than Sleeper's, or we don't ship them.*

**Phase 4b — Team context and scheme model.** Built alongside the projections, because player usage is downstream of team behavior — and because you asked to see it directly:
- **Pace** (seconds per play, plays per game, neutral-script pace), **PROE** (pass rate over expected, given down/distance/score/time) — the two numbers that decide how much fantasy volume a team even generates.
- **Neutral-script tendencies** vs. game-script-forced behavior, separated.
- **Red-zone and goal-line tendencies** — who actually gets the touchdown equity.
- **Defensive scheme profiles** — pressure/blitz rate, coverage shell, man-zone split, box counts, shadow-corner usage — all opponent-adjusted rather than raw fantasy points allowed. These feed the QB-first propagation model described above.
- **Depth chart state and trend** — nflverse depth charts joined to snap-share trajectories, so you see who's actually rising, not who's listed second.
- **Coaching/coordinator change detection** — flags where history should be discounted.

→ *A team page that tells you why a player's volume is what it is, and a depth-chart view that shows role changes before the box score does.*

**Phase 5 — Simulation engine.** What MFA got right, plus what it lacks:
- Bipartite lineup solver over eligible slots (FLEX/WRRB/REC_FLEX/SUPER_FLEX/IDP) — correct, not greedy.
- Sampling driven by the v3+ correlated distributions, not independent normals.
- Managers simulated at their *own* measured lineup efficiency, not perfection.
- Injuries via hazard model with covariates (position, age, usage, injury history), durations from the empirical distribution.
- Seeded PRNG, 10k iterations, Web Worker, playoff bracket inside each iteration.
- Weekly odds snapshots to Postgres → real "your title odds moved −3.2% this week" that survives clearing your browser.

**Phase 6 — Odds calibration.** Backtest the full season simulator on completed seasons: reliability curve (when we said 60%, did 60% happen?), Brier score. Published in-app, with honest error bars replacing false precision.

**Phase 7 — Team evaluation, rankings, metrics.** Every team ranked three ways — market value, projected wins, championship odds — with the *gaps* called out, since that's where the information is (high value + low odds = bad construction or brutal schedule). Plus:
- **Schedule luck** — your record vs. your record against all 11 other schedules.
- **Lineup efficiency** — points ÷ optimal lineup, per manager, converted into wins lost.
- **Leverage** — which remaining games actually swing your title odds.
- **Positional scarcity** — strength vs. *this league's* replacement level, not a generic one.
- **Age curve vs. contention window** — old-and-losing or young-and-winning are the two actionable mismatches.
- **Buy-low / sell-high** — market value trend diverging from projection trend.
- **Fragility** — share of your title odds riding on your top two players.
- **Pick equity** — future picks valued from your own simulated finish, not a generic chart.

**Phase 8 — Decisions (the product).**
- *Trade evaluator:* simulate both rosters before and after. Both sides see Δ market value, Δ projected wins, Δ playoff odds, Δ title odds. Ends the argument.
- *Trade finder:* combinatorially explosive, so pipelined — enumerate 1-for-1 / 2-for-1 / 2-for-2 + picks → filter to a market-value fairness band (~±15%) so proposals are plausibly acceptable → rank by a cheap proxy (Δ projected starter points at your needed positions) → run the full 10k sim on the top ~10 only. Input: "I need WR, I'll deal RB depth." Output: ranked realistic packages with both teams' odds change.
- *Waivers:* every free agent ranked by Δ playoff odds **for your roster specifically**, with **Kelly-sized FAAB bids** from that edge — a backup RB worth 4% to you and 0% to everyone else is exactly what you should overpay for.
- *Start/sit:* priced in title odds, not projected points.

**Phase 9 — Yahoo adapter.** OAuth2 authorization-code flow, token refresh, mapping into the same domain model, crosswalk extension.

**Phase 10 — Compounding data.** Own value index from observed trades, own rostership, own ADP from ingested drafts, public accuracy dashboard. The moat only grows with time, which is why snapshotting starts in Phase 4/5, not here.

---

## UI and design

**Design language: 538, light mode.** Off-white background, strong typographic hierarchy, muted categorical palette, direct labeling instead of legends where possible, and — the important one — **uncertainty is always visible**: fan charts and probability bands, never a bare point estimate. Dark mode supported but light is the default. Charts get built with the `dataviz` skill so the whole app reads as one system.

**League scoping.** Everything is per-league. A persistent league switcher across the top (your two Sleeper leagues + one Yahoo), because dynasty and redraft answers are different answers — a redraft league shouldn't show you 2027 pick equity, and a dynasty league shouldn't rank teams purely on this year's odds. Cross-league views exist only where they're genuinely useful ("all my lineups this week", "every player I roster anywhere").

**Pages:**

| Page | What it answers | Key visuals |
|---|---|---|
| League home | Where do I stand, what changed | Odds fan chart over the season, standings table, weekly movers |
| Outlook | How does this end | Playoff/title odds with error bands, remaining schedule with win probabilities, leverage-ranked games |
| Power rankings | Who's actually good | Three-way ranking (market value / projected wins / title odds) with divergence called out; stacked positional value bars |
| Team page | Why is this roster what it is | Positional strength vs. league replacement level, age curve vs. contention window, fragility, roster table |
| Player page | Should I believe in him | Projection distribution (not a number), usage trend small multiples, market value history vs. projection trend, depth chart context |
| **Lineup** | Who do I start | Start/sit priced in title odds, with the win-probability gap between options and a "this decision doesn't matter" flag when it truly doesn't |
| **Waivers** | Who do I claim, for how much | FA table ranked by Δ playoff odds for *your* roster, Kelly-sized FAAB bid, rostership signal |
| **Trades** | Is this good, and what else is out there | Evaluator with both sides' Δ value and Δ odds side by side; finder with ranked realistic packages |
| Team context | Why does this offense produce | Pace and PROE scatter, red-zone tendency, defensive strength faced, depth charts with snap trends |
| **Matchup** | What does this defense do to my guys | The propagation chain made visible: defense's scheme profile → effect on the QB → resulting shift in target allocation → per-player Δ projection, with shrinkage-adjusted confidence on each link |
| Long-term | Am I building or stalling | Multi-year window projection, pick equity, age/value curve, buy-low & sell-high lists |
| Model accuracy | Should I trust any of this | Reliability diagram, CRPS/Brier vs. baselines, ladder version history |

**Interaction principles:** every table sortable and exportable; every projection hoverable to see its distribution; every odds number clickable through to *what drove it*. Dropdowns for league, season, week, and scoring view. Nothing shows a decimal the model can't support.

---

## Things only you can do (start now — off the critical path)

1. **Yahoo dev app** — developer.yahoo.com, enable Fantasy Sports read, set redirect URI, save Client ID + Secret into `.env.local`. I can't create accounts or handle credentials.
2. **The Odds API key** — free-tier signup, paste into `.env.local`.
3. **Git push credentials** — no `gh` CLI, no SSH key found; `credential.helper=osxkeychain` is set but `user.name`/`user.email` are unset. Run `! git config --global user.name "..."` and `! git config --global user.email "..."`, then either `! brew install gh && gh auth login` or let the keychain prompt on first push.
4. **Supabase + Vercel** — I scaffold config and migrations; you authorize CLI logins.

---

## Verification

- **Engine correctness:** unit tests on the lineup solver against hand-computed SuperFlex/FLEX cases; fixed-seed sims reproduce identically; a toy two-team league converges to known win probabilities.
- **Model quality:** every ladder rung reports out-of-sample CRPS/log-score/MAE vs. v0 and vs. Sleeper's projections on the same weeks. A rung that doesn't beat the previous one doesn't ship. Results committed as a table in the repo so the history is visible.
- **No leakage:** a deliberate test that trains on week ≤ N and asserts no feature in the serve-time set has an as-of timestamp after week N.
- **Odds calibration:** reliability curve + Brier score from Phase 6 backtests.
- **End-to-end:** load Badger Dynasty, confirm standings/rosters match Sleeper exactly, then drive the UI with Claude in Chrome — link league, run outlook, propose a trade, check waivers — screenshotting each step.
- **Against the incumbents:** run the same league through My Fantasy Analyzer and Dynasty Daddy; differences must be explainable (correlation, manager efficiency, better projections), not mysterious.

---

## Sequencing note

Phases 2–4 are the real investment and where "top tier" is either earned or not. Phases 7–8 are what you actually use on Sunday. If you want something usable sooner, we can run the sim on blended third-party projections after Phase 5 and swap in our own engine when it clears the gates — the interfaces are designed so that's a config change, not a rewrite.
