import { LeagueNav } from '@/components/LeagueNav';
import { TradeBuilder } from '@/components/TradeBuilder';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { serializeLeague } from '@/lib/serialize';
import { loadTrades } from '@/lib/trade-data';
import { loadMarketValues } from '@/lib/values';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

const pct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

const VERDICT_COLOR: Record<string, string> = {
  thin: 'var(--bad)',
  balanced: 'var(--ink-muted)',
  surplus: 'var(--good)',
};

export default async function TradesPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);

  if (view.myTeamId === null) {
    return <main className="mx-auto max-w-5xl px-6 py-12">Could not find your team in this league.</main>;
  }

  const myTeamId = view.myTeamId;
  const { snapshot } = view;

  const [trades, values, players] = await Promise.all([
    loadTrades(view, myTeamId),
    loadMarketValues(snapshot.league.format, snapshot.league.superFlex),
    loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
  ]);

  const wire = serializeLeague(view, values, players);

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

      <main className="mx-auto max-w-5xl px-6 pb-20">
        <section className="mb-12">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
            Trade calculator
          </h2>
          <p className="mb-4 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
            Pick players from either side. Each change re-simulates the rest of the season in your
            browser: market value for whether they&apos;d accept, championship odds for whether you
            should want it.
          </p>
          <TradeBuilder league={wire} myTeamId={myTeamId} />
        </section>

        {trades !== null && trades.partners.length > 0 && (
          <section className="mb-12">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Who to call
            </h2>
            <p className="mb-4 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
              Every roster in the league analysed the same way as yours. A trade happens when the
              piece you are offering is worth more to them than what they give up — so fit is scored
              in both directions.
            </p>

            <div className="space-y-3">
              {trades.partners.map((partner) => (
                <article
                  key={partner.partnerTeamId}
                  className="rounded border p-4"
                  style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {view.teamNames.get(partner.partnerTeamId) ?? partner.partnerTeamId}
                    </span>
                    <span className="tabular text-xs" style={{ color: 'var(--ink-faint)' }}>
                      fit {partner.mutualFit.toFixed(1)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm" style={{ color: 'var(--ink-muted)' }}>
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
                          <li key={offer.playerId} className="flex justify-between gap-4 py-0.5">
                            <span>
                              {offer.name}
                              <span className="ml-1.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
                                {offer.position}
                              </span>
                            </span>
                            <span className="tabular shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
                              costs you nothing · worth +{offer.helpsThemBy.toFixed(1)} to them
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {trades !== null && trades.depth.length > 0 && (
          <section className="mb-12">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              What you can actually spare
            </h2>
            <p className="mb-4 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
              Measured by consequence, not headcount: what your best lineup loses without each
              player. A backup behind an elite starter reads as spare; a mediocre starter at a thin
              spot does not.
            </p>

            <div className="scroll-x mb-6">
              <table className="w-full min-w-[30rem] text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-widest"
                    style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}>
                    <th className="py-2">Position</th>
                    <th className="py-2">Depth</th>
                    <th className="py-2 text-right">Lineup leans on it</th>
                    <th className="py-2 text-right">If top player lost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...trades.depth]
                    .sort((a, b) => b.totalMarginal - a.totalMarginal)
                    .map((assessment) => (
                      <tr key={assessment.position} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                        <td className="py-2 font-medium">{assessment.position}</td>
                        <td className="py-2 font-medium" style={{ color: VERDICT_COLOR[assessment.verdict] }}>
                          {assessment.verdict}
                        </td>
                        <td className="tabular py-2 text-right">{assessment.totalMarginal.toFixed(1)}</td>
                        <td className="tabular py-2 text-right" style={{ color: 'var(--ink-muted)' }}>
                          −{assessment.exposureToTopLoss.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Most movable players
            </h3>
            <div className="scroll-x">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-widest"
                    style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}>
                    <th className="py-2">Player</th>
                    <th className="py-2 text-right">Projects</th>
                    <th className="py-2 text-right">Lineup loses</th>
                    <th className="py-2 text-right">Market value</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.marginal.slice(0, 10).map((entry) => (
                    <tr key={entry.playerId} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                      <td className="py-2">
                        <span className="font-medium">{entry.name}</span>
                        <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                          {entry.position}
                        </span>
                      </td>
                      <td className="tabular py-2 text-right">{entry.projected.toFixed(1)}</td>
                      <td className="tabular py-2 text-right font-medium"
                        style={{ color: entry.marginal < 1 ? 'var(--good)' : 'var(--ink)' }}>
                        −{entry.marginal.toFixed(1)}
                      </td>
                      <td className="tabular py-2 text-right" style={{ color: 'var(--ink-muted)' }}>
                        {entry.value > 0 ? entry.value.toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs" style={{ color: 'var(--ink-faint)' }}>
              A player who costs the lineup nothing but carries real market value is the ideal chip:
              you are selling something the market prices and your roster does not use.
            </p>
          </section>
        )}

        {trades !== null && trades.evaluations.length > 0 && (
          <section>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
              Proposals worth making
            </h2>
            <p className="mb-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
              Scanned across the league, filtered to packages a real manager might accept.
            </p>

            <div className="space-y-4">
              {trades.evaluations.map((evaluation, index) => {
                const mine = evaluation.odds.get(myTeamId);
                const theirs = evaluation.odds.get(evaluation.sideB.teamId);
                const partner = view.teamNames.get(evaluation.sideB.teamId) ?? evaluation.sideB.teamId;

                return (
                  <article key={index} className="rounded border p-5"
                    style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
                    <div className="mb-3 text-xs uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
                      with {partner}
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--ink-faint)' }}>
                          You send
                        </div>
                        {evaluation.sideA.sends.map((asset) => (
                          <div key={String(asset.playerId)} className="font-medium">
                            {asset.name}{' '}
                            <span className="text-xs font-normal" style={{ color: 'var(--ink-faint)' }}>
                              {asset.position}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--ink-faint)' }}>
                          You get
                        </div>
                        {evaluation.sideB.sends.map((asset) => (
                          <div key={String(asset.playerId)} className="font-medium">
                            {asset.name}{' '}
                            <span className="text-xs font-normal" style={{ color: 'var(--ink-faint)' }}>
                              {asset.position}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t pt-3 text-sm"
                      style={{ borderColor: 'var(--rule)' }}>
                      <span>
                        <span style={{ color: 'var(--ink-muted)' }}>Your title odds </span>
                        <strong className="tabular"
                          style={{ color: (mine?.titleDelta ?? 0) > 0 ? 'var(--good)' : 'var(--bad)' }}>
                          {pct(mine?.titleDelta ?? 0)}
                        </strong>
                      </span>
                      <span>
                        <span style={{ color: 'var(--ink-muted)' }}>Theirs </span>
                        <strong className="tabular"
                          style={{ color: (theirs?.titleDelta ?? 0) > 0 ? 'var(--good)' : 'var(--bad)' }}>
                          {pct(theirs?.titleDelta ?? 0)}
                        </strong>
                      </span>
                      <span>
                        <span style={{ color: 'var(--ink-muted)' }}>Market gap </span>
                        <strong className="tabular">{(evaluation.fairness * 100).toFixed(0)}%</strong>
                      </span>
                    </div>

                    <p className="mt-2 text-sm" style={{ color: 'var(--ink-muted)' }}>{evaluation.verdict}</p>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
