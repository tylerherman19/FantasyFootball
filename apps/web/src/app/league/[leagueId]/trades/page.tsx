import { LeagueNav } from '@/components/LeagueNav';
import { Section } from '@/components/Section';
import { TradeBuilder } from '@/components/TradeBuilder';
import {
  CellBar,
  DivergingBar,
  Legend,
  PositionChip,
  StackedBar,
  formatPct,
} from '@/components/charts/primitives';
import { requireSession } from '@/lib/session';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { serializeLeague } from '@/lib/serialize';
import { loadTrades } from '@/lib/trade-data';
import { loadPicks } from '@/lib/pick-data';
import { loadMarketValues } from '@/lib/values';

const pct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

const VERDICT_COLOR: Record<string, string> = {
  thin: 'var(--bad)',
  balanced: 'var(--ink-muted)',
  surplus: 'var(--good)',
};

export default async function TradesPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const session = await requireSession();
  const view = await loadLeague(leagueId, session.username);

  if (view.myTeamId === null) {
    return <main className="mx-auto max-w-5xl px-6 py-12">Could not find your team in this league.</main>;
  }

  const myTeamId = view.myTeamId;
  const { snapshot } = view;

  const [trades, values, players, picks] = await Promise.all([
    loadTrades(view, myTeamId),
    loadMarketValues(snapshot.league.format, snapshot.league.superFlex),
    loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
    loadPicks(view),
  ]);

  const wire = serializeLeague(view, values, players, picks);

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="trades"
        format={snapshot.league.format}
      />

      <main className="mx-auto max-w-6xl px-5 pb-20">
        <Section
          title="Trade calculator"
          note={
            <>
              Pick players from either side. Each change re-simulates the rest of the season in your
              browser: market value for whether they&apos;d accept, championship odds for whether you
              should want it.
            </>
          }
        >
          <TradeBuilder league={wire} myTeamId={myTeamId} />
        </Section>

        {trades !== null && trades.partners.length > 0 && (
          <Section
            title="Who to call"
            note={
              <>
                Every roster in the league analysed the same way as yours. A trade happens when the
                piece you are offering is worth more to them than what they give up — so fit is
                scored in both directions, and the bar is how well the two rosters complement each
                other.
              </>
            }
          >
            <div className="space-y-2">
              {trades.partners.map((partner) => (
                <article key={partner.partnerTeamId} className="panel p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold">
                      {view.teamNames.get(partner.partnerTeamId) ?? partner.partnerTeamId}
                    </span>
                    <CellBar
                      value={partner.mutualFit}
                      max={Math.max(...trades.partners.map((other) => other.mutualFit), 1)}
                      width={110}
                      color="var(--p-high)"
                      label={`fit ${partner.mutualFit.toFixed(1)}`}
                    />
                  </div>
                  <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {partner.reason}
                  </p>

                  {partner.offers.length > 0 && (
                    <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--rule)' }}>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest"
                        style={{ color: 'var(--ink-faint)' }}>
                        Offer them
                      </div>
                      <ul className="text-sm">
                        {partner.offers.map((offer) => (
                          <li key={offer.playerId} className="flex items-center gap-2 py-0.5">
                            <PositionChip position={offer.position} />
                            <span className="min-w-0 flex-1 truncate text-xs">{offer.name}</span>
                            <CellBar
                              value={offer.helpsThemBy}
                              max={Math.max(
                                ...trades.partners.flatMap((other) =>
                                  other.offers.map((entry) => entry.helpsThemBy),
                                ),
                                1,
                              )}
                              width={80}
                              color="var(--good)"
                              label={`+${offer.helpsThemBy.toFixed(1)} to them`}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </Section>
        )}

        {trades !== null && trades.depth.length > 0 && (
          <Section
            title="What you can actually spare"
            note={
              <>
                Measured by consequence, not headcount: what your best lineup loses without each
                player. A backup behind an elite starter reads as spare; a mediocre starter at a thin
                spot does not.
              </>
            }
          >

            <div className="panel mb-5 divide-y" style={{ borderColor: 'var(--rule)' }}>
              {[...trades.depth]
                .sort((a, b) => b.totalMarginal - a.totalMarginal)
                .map((assessment) => (
                  <div key={assessment.position} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-9 shrink-0">
                      <PositionChip position={assessment.position} />
                    </span>
                    <span
                      className="w-16 shrink-0 text-[11px] font-medium"
                      style={{ color: VERDICT_COLOR[assessment.verdict] }}
                    >
                      {assessment.verdict}
                    </span>
                    <span className="min-w-0 flex-1">
                      <StackedBar
                        max={Math.max(...trades.depth.map((entry) => entry.totalMarginal), 1)}
                        width={300}
                        height={13}
                        showLabels={false}
                        segments={[
                          { key: 'exposed', value: assessment.exposureToTopLoss, color: 'var(--bad)' },
                          {
                            key: 'rest',
                            value: Math.max(0, assessment.totalMarginal - assessment.exposureToTopLoss),
                            color: 'var(--p-high)',
                          },
                        ]}
                      />
                    </span>
                    <span className="tabular w-12 shrink-0 text-right text-xs">
                      {assessment.totalMarginal.toFixed(1)}
                    </span>
                    <span className="tabular w-12 shrink-0 text-right text-xs" style={{ color: 'var(--bad)' }}>
                      −{assessment.exposureToTopLoss.toFixed(1)}
                    </span>
                  </div>
                ))}
            </div>

            <h3 className="eyebrow mb-2">Most movable players</h3>
            <div className="panel scroll-x">
              <table className="data-table" style={{ minWidth: '34rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '2rem' }} />
                    <th style={{ minWidth: '10rem' }}>Player</th>
                    <th style={{ width: '7rem' }}>Projects</th>
                    <th style={{ width: '7rem' }}>Lineup loses</th>
                    <th style={{ width: '7rem' }}>Market value</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.marginal.slice(0, 12).map((entry) => (
                    <tr key={entry.playerId}>
                      <td>
                        <PositionChip position={entry.position} />
                      </td>
                      <td className="max-w-[13rem] truncate font-medium">{entry.name}</td>
                      <td>
                        <CellBar
                          value={entry.projected}
                          max={Math.max(...trades.marginal.map((other) => other.projected), 1)}
                          width={50}
                          color="var(--p-low)"
                          label={entry.projected.toFixed(1)}
                        />
                      </td>
                      <td>
                        <CellBar
                          value={entry.marginal}
                          max={Math.max(...trades.marginal.map((other) => other.marginal), 1)}
                          width={50}
                          color={entry.marginal < 1 ? 'var(--good)' : 'var(--p-high)'}
                          label={entry.marginal.toFixed(1)}
                        />
                      </td>
                      <td>
                        <CellBar
                          value={entry.value}
                          max={Math.max(...trades.marginal.map((other) => other.value), 1)}
                          width={50}
                          color="var(--pos-qb)"
                          label={entry.value > 0 ? entry.value.toLocaleString() : '—'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
              A player whose market bar is long and whose &ldquo;lineup loses&rdquo; bar is short is
              the ideal chip: you are selling something the market prices and your roster does not
              use.
            </p>
          </Section>
        )}

        {trades !== null && trades.evaluations.length > 0 && (
          <Section
            title="Proposals worth making"
            note="Scanned across the league, filtered to packages a real manager might accept, then simulated. The bars are the change in each side's title probability — a proposal where both bars point right is the rare genuinely mutual trade."
            aside={
              <Legend
                items={[
                  { label: 'helps', color: 'var(--good)' },
                  { label: 'hurts', color: 'var(--bad)' },
                ]}
              />
            }
          >
            <div className="space-y-3">
              {trades.evaluations.map((evaluation, index) => {
                const mine = evaluation.odds.get(myTeamId);
                const theirs = evaluation.odds.get(evaluation.sideB.teamId);
                const partner = view.teamNames.get(evaluation.sideB.teamId) ?? evaluation.sideB.teamId;

                // A common scale across every proposal, so the bars compare.
                const widest = Math.max(
                  ...trades.evaluations.flatMap((other) => [
                    Math.abs(other.odds.get(myTeamId)?.titleDelta ?? 0),
                    Math.abs(other.odds.get(other.sideB.teamId)?.titleDelta ?? 0),
                  ]),
                  0.005,
                );

                return (
                  <article key={index} className="panel p-4">
                    <div className="eyebrow mb-3">with {partner}</div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <div className="axis-label mb-1 uppercase tracking-wider">You send</div>
                        {evaluation.sideA.sends.map((asset) => (
                          <div key={String(asset.playerId)} className="flex items-center gap-1.5 py-0.5">
                            <PositionChip position={asset.position} />
                            <span className="truncate text-sm font-medium">{asset.name}</span>
                            <span className="tabular ml-auto text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                              {asset.value.toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="axis-label mb-1 uppercase tracking-wider">You get</div>
                        {evaluation.sideB.sends.map((asset) => (
                          <div key={String(asset.playerId)} className="flex items-center gap-1.5 py-0.5">
                            <PositionChip position={asset.position} />
                            <span className="truncate text-sm font-medium">{asset.name}</span>
                            <span className="tabular ml-auto text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                              {asset.value.toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div
                      className="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-3"
                      style={{ borderColor: 'var(--rule)' }}
                    >
                      <div>
                        <div className="axis-label">Your title odds</div>
                        <DivergingBar
                          value={mine?.titleDelta ?? 0}
                          max={widest}
                          width={140}
                          label={pct(mine?.titleDelta ?? 0)}
                        />
                      </div>
                      <div>
                        <div className="axis-label">Their title odds</div>
                        <DivergingBar
                          value={theirs?.titleDelta ?? 0}
                          max={widest}
                          width={140}
                          label={pct(theirs?.titleDelta ?? 0)}
                        />
                      </div>
                      <div>
                        <div className="axis-label">Market gap</div>
                        <CellBar
                          value={evaluation.fairness}
                          max={0.3}
                          width={90}
                          color={evaluation.fairness > 0.2 ? 'var(--warn)' : 'var(--p-mid)'}
                          label={formatPct(evaluation.fairness)}
                        />
                      </div>
                    </div>

                    <p className="mt-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {evaluation.verdict}
                    </p>
                  </article>
                );
              })}
            </div>
          </Section>
        )}

      </main>
    </>
  );
}
