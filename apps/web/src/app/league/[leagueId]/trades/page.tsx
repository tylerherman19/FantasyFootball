import { LeagueNav } from '@/components/LeagueNav';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadTrades } from '@/lib/trade-data';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

const pct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

export default async function TradesPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);

  if (view.myTeamId === null) {
    return <main className="mx-auto max-w-4xl px-6 py-12">Could not find your team in this league.</main>;
  }

  const trades = await loadTrades(view, view.myTeamId);
  const myTeamId = view.myTeamId;

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={view.snapshot.league.name}
        meta={leagueMeta(view.snapshot)}
        lineupShape={lineupShape(view.snapshot)}
        active="trades"
        format={view.snapshot.league.format}
      />
      <main className="mx-auto max-w-5xl px-6 pb-20">
      <p className="mb-8 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        Market value decides whether they&apos;d accept. Simulation decides whether you should want
        it. Only proposals that clear both are shown.
      </p>

      {trades === null && <p style={{ color: 'var(--ink-muted)' }}>No projections available yet.</p>}

      {trades !== null && (
        <>
          <div className="mb-8 text-sm" style={{ color: 'var(--ink-muted)' }}>
            Reading your roster as needing{' '}
            <strong style={{ color: 'var(--ink)' }}>{trades.needs.join(', ') || 'nothing'}</strong>
            {trades.surplus.length > 0 && (
              <>
                {' '}and able to spare{' '}
                <strong style={{ color: 'var(--ink)' }}>{trades.surplus.join(', ')}</strong>
              </>
            )}
            .
          </div>

          {trades.evaluations.length === 0 && (
            <div
              className="rounded border p-4 text-sm"
              style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
            >
              <strong>No trade improves your odds right now.</strong>{' '}
              {!trades.valuesAvailable
                ? 'Market values are unavailable, so fairness cannot be checked.'
                : trades.needs.length === 0
                  ? 'Your roster has no positional hole worth trading to fill.'
                  : 'Every fair package that fills your need costs more than it returns.'}
            </div>
          )}

          <div className="space-y-4">
            {trades.evaluations.map((evaluation, index) => {
              const mine = evaluation.odds.get(myTeamId);
              const theirs = evaluation.odds.get(evaluation.sideB.teamId);
              const partnerName = view.teamNames.get(evaluation.sideB.teamId) ?? evaluation.sideB.teamId;

              return (
                <article
                  key={index}
                  className="rounded border p-5"
                  style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
                >
                  <div className="mb-3 text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
                    with {partnerName}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
                        You send
                      </div>
                      <ul className="mt-1">
                        {evaluation.sideA.sends.map((asset) => (
                          <li key={String(asset.playerId)} className="font-medium">
                            {asset.name}{' '}
                            <span className="text-xs font-normal" style={{ color: 'var(--ink-muted)' }}>
                              {asset.position}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
                        You get
                      </div>
                      <ul className="mt-1">
                        {evaluation.sideB.sends.map((asset) => (
                          <li key={String(asset.playerId)} className="font-medium">
                            {asset.name}{' '}
                            <span className="text-xs font-normal" style={{ color: 'var(--ink-muted)' }}>
                              {asset.position}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t pt-3 text-sm" style={{ borderColor: 'var(--rule)' }}>
                    <span>
                      <span style={{ color: 'var(--ink-muted)' }}>Your title odds </span>
                      <strong className="tabular" style={{ color: (mine?.titleDelta ?? 0) > 0 ? 'var(--good)' : 'var(--bad)' }}>
                        {pct(mine?.titleDelta ?? 0)}
                      </strong>
                    </span>
                    <span>
                      <span style={{ color: 'var(--ink-muted)' }}>Theirs </span>
                      <strong className="tabular" style={{ color: (theirs?.titleDelta ?? 0) > 0 ? 'var(--good)' : 'var(--bad)' }}>
                        {pct(theirs?.titleDelta ?? 0)}
                      </strong>
                    </span>
                    <span>
                      <span style={{ color: 'var(--ink-muted)' }}>Market gap </span>
                      <strong className="tabular">{(evaluation.fairness * 100).toFixed(0)}%</strong>
                    </span>
                  </div>

                  <p className="mt-2 text-sm" style={{ color: 'var(--ink-muted)' }}>
                    {evaluation.verdict}
                  </p>
                </article>
              );
            })}
          </div>
        </>
      )}
    </main>
    </>
  );
}
