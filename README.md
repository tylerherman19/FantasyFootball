# Fantasy Football Edge

Every fantasy decision — start/sit, waiver claim, trade, rebuild-or-contend — priced in the
same two currencies: **market value** and **championship probability added**.

Supports Sleeper and Yahoo; dynasty, keeper, redraft and guillotine leagues.

## Why this exists

Existing tools each solve half the problem. One has a real simulation engine running on
borrowed projections. The other has real data but converts it to playoff odds with a linear
rating gap and a coin flip. Neither measures whether it's right.

This one owns its projections, simulates actual football, and scores itself every week.

## Layout

```
packages/core        pure TS — domain model, projections, simulation, decisions
packages/adapters    Sleeper + Yahoo, behind one PlatformAdapter interface
packages/ingest      nflverse, FantasyCalc, DynastyProcess, odds loaders
model/               Python (uv) — feature store, training, backtesting; offline only
apps/web             Next.js UI
supabase/migrations  schema
```

`packages/core` never imports a platform SDK, `fetch`, or React. Numbers in, numbers out —
which is what makes it testable and backtestable.

Python trains and exports versioned artifacts; TypeScript serves them. **Python never runs
in the serving path.**

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in your keys
```

## Commands

```bash
npm run smoke:sleeper -- <sleeper-username> <season>   # load real leagues, print the domain model
npm run typecheck
npm test
```

## Status

- [x] Phase 0 — scaffold
- [x] Phase 1 — Sleeper adapter + domain model
- [x] Phase 2 — historical data lake + point-in-time feature store
- [x] Phase 3 — backtest harness
- [~] Phase 4 — projection engine (Marcel → v1 usage + positional; v2+ not started)
- [x] Phase 4b — defensive scheme profiles, exported and surfaced per matchup
- [x] Phase 5 — simulation engine
- [~] Phase 6 — odds calibration (spread calibration exported; reliability curve not in-app)
- [x] Phase 7 — rankings and metrics
- [x] Phase 8 — trades, waivers, lineups
- [~] Phase 9 — Yahoo adapter (client + OAuth written, not wired to the UI)
- [ ] Phase 10 — compounding data

Full plan: `docs/PLAN.md`

## Two things worth knowing before reading the numbers

**Decisions are priced in three currencies, not one.** Championship probability
is the one that matters, but a season simulated 4,000 times resolves it no finer
than a couple of percentage points — so in August, and after any small move, it
cannot tell a real upgrade from noise. Filtering on it is what made the trade and
waiver pages render empty. Every decision therefore reports market value, exact
projected starter points, *and* title odds, and says out loud when an odds move
is inside the simulation's resolution.

**Projections are exported one week at a time.** `buildPool` reuses the latest
week for the rest of the season, which is honest for a rest-of-season simulation
but is not a per-week forecast. Multi-week export is the next correctness item.

## Serving path

Nothing in the request path recomputes what it can remember. The projection
artifact, the identity crosswalk, the league load (including its season
simulation), the trade search and week leverage are all memoized per league for
sixty seconds. Before that, a single page view parsed a megabyte of JSON three
times and re-ran a 4,000-iteration season on every tab click.
