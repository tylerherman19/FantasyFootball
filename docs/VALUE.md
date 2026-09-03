# Value — the model prices players itself

Status: shipped on `feat/internal-value-model`. FantasyCalc is no longer a
dependency of any decision path. It survives as an optional sanity comparison
(`scripts/value-sanity.mts`) and a display card on the player page, nothing
more.

## Why

The audit (docs/AUDIT.md) set the bar: every number this product stands on is
computed from its own data, backtested where possible, documented where not.
The one number that failed that bar was the price. Market value came from
FantasyCalc, and the dependency kept proving itself expensive:

- A cold-cache outage emptied the value map and trade suggestions silently
  vanished — the page read "no good trades exist" when it meant "a feed is
  down."
- Players missing from the feed were dropped from trade packages entirely —
  silent omission, the same failure shape.
- The feed's 0–9999 scale leaked into decision code as bare constants
  (`value >= 6_000` in two places), so the meaning of those thresholds
  changed whenever the feed's population did.
- Keeper leagues were priced with dynasty values — the wrong currency,
  invisible until you went looking.

## What replaced it

`packages/core/src/valuation/edge-value.ts`. The price of a player is PAR —
**points above replacement** — because that is the definition of what a
roster spot buys. Every input is already in the repository:

| Input | Source |
| --- | --- |
| Weekly projection | `model/artifacts/projections-*.json`, scored under the league's own rules |
| Replacement level | The best non-starter in the full player pool, per position, from this league's actual starter demand (lineup slots × teams) |
| Age effect | `model/artifacts/age-curves.json` — the measured delta-method curves, walked year by year |
| Games remaining | The league's regular-season weeks minus remaining byes |
| Rookie draft capital | `crosswalk.json` draft slot, for the pick chart |

Two horizons, because the formats price different things:

- **Redraft / guillotine:** PAR over the rest of this season. A 30-year-old
  and a 23-year-old with the same projection are worth the same, because in
  redraft they are.
- **Dynasty / keeper:** PAR over the next four seasons, future years walked
  along the measured age curves. The old `fundamental.ts` — a hand-set
  PEAK/ANNUAL_DECLINE table blended 45/55 with the market anchor — is
  deleted.

Design choices that are asserted rather than measured are stated at the code
site: the flex-slot split across eligible positions, SUPER_FLEX counting as a
full QB slot, a four-year horizon, holding curve-unreachable years flat, and
no time discounting (the contend/rebuild read owns sooner-vs-later; the price
stays out of it).

Draft picks are priced by `edgePickChart`: a log-linear fit of this rookie
class's dynasty values against their draft slots — the model's own rookie
priors (fitted over ten completed classes) turned into a slot curve. No
borrowed chart. With fewer than eight usable rookies the chart refuses to
price, and the UI says so rather than guessing.

## Where it runs

Every surface that used to read `loadMarketValues`/`loadMarketData` now reads
`loadEdgeValues` / `loadEdgePlayerValues` (`apps/web/src/lib/edge-values.ts`):
trades (fairness band and suggestions), draft picks, dynasty, power rankings,
roster analysis, the lineup/waiver/player pages, and static export. Zero PAR
is a statement — "freely available" — not missing data; unpriced means absent
from the map, and nothing conflates the two.

## The calibration

`npm run sanity:value` compares the model against the live FantasyCalc feed
for a canonical 12-team dynasty superflex PPR league. Measured 2026-09-03,
week-1 artifact (2,516 projections), 327 players priced by both:

- **Spearman ρ = 0.743** across all 327.
- Top-25 overlap 14/25, top-50 36/50, top-100 81/100.
- The systematic disagreement is *old producers*, and it is mostly the market
  discounting them, not the model overrating them: with the curve's final
  slope extended past its endpoint, 32-year-old receivers (Adams, Evans) read
  a four-year multiple of 1.0 — the model agrees they are year-to-year. The
  residue is quarterbacks: the measured QB curve ends flat at 27 where the
  sample thins, so a 37-year-old Stafford holds a 3.9 multiple and the model
  prices him #7 to the market's #76. That is the honest "we don't know"
  documented in the module, not a number to tune toward the feed.

Rerun it after any model or age-curve change; a collapsing ρ is the alarm,
not a target to maximize.

## What the market is still for

Exactly two things, both optional: the player page shows the FantasyCalc
price as a labelled comparison, and the snapshot job keeps archiving market
history (the accuracy moat — you cannot backtest against a feed you didn't
save). If the feed dies tomorrow, no page changes.
