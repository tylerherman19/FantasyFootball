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

## Production secrets

Four features — the freshness panel, the canonical store, the projection history
and the daily refresh cron — are deployed but inert until the deployment can
reach Supabase. Three variables turn them on:

```bash
npm run setup:vercel     # reads .env.local, generates CRON_SECRET, pushes to Vercel
npx vercel --prod        # redeploy so they take effect
```

The script is idempotent, so re-running it is also how you rotate a value. Until
it has run, the pages say plainly that the store is unreachable rather than
pretending there is no data.

## Commands

```bash
npm run smoke:sleeper -- <sleeper-username> <season>   # load real leagues, print the domain model
npm run dev --workspace=@ffe/web                       # then enter your Sleeper username
npm run typecheck
npm test
```

Sign-in is just a Sleeper username — the platform's league data is public, so there is no
password to hold and nothing is written back to your account. It is remembered in a cookie,
which is what lets the app find *your* team inside each league.

## Status

- [x] Phase 0 — scaffold
- [x] Phase 1 — Sleeper adapter + domain model
- [ ] Phase 2 — historical data lake + point-in-time feature store
- [ ] Phase 3 — backtest harness
- [ ] Phase 4 — projection engine (v0 Marcel → v4 ensemble)
- [ ] Phase 5 — simulation engine
- [ ] Phase 6 — odds calibration
- [ ] Phase 7 — rankings and metrics
- [ ] Phase 8 — trades, waivers, lineups
- [ ] Phase 9 — Yahoo adapter
- [ ] Phase 10 — compounding data

Full plan: `docs/PLAN.md`
