import { LeagueNav } from '@/components/LeagueNav';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadWaivers } from '@/lib/waiver-data';

/**
 * Waiver analysis is a few seconds of simulation, and the inputs only change
 * when rosters or projections do. Cache it for fifteen minutes so revisiting
 * the page is instant; a manual reload after a transaction still picks up the
 * change well inside a waiver window.
 */
export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

const pct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

export default async function WaiversPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);

  if (view.myTeamId === null) {
    return <main className="mx-auto max-w-4xl px-6 py-12">Could not find your team in this league.</main>;
  }

  const waivers = await loadWaivers(view, view.myTeamId);

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={view.snapshot.league.name}
        meta={leagueMeta(view.snapshot)}
        lineupShape={lineupShape(view.snapshot)}
        active="waivers"
        format={view.snapshot.league.format}
      />
      <main className="mx-auto max-w-5xl px-6 pb-20">
      <p className="mb-8 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        Ranked by what each player does to <em>your</em> title odds, not by projected points. A
        backup running back is worth a lot to the manager whose starter just went down and nothing
        to everyone else — same player, same projection.
      </p>

      {waivers === null && <p style={{ color: 'var(--ink-muted)' }}>No projections available for this week yet.</p>}

      {waivers !== null && waivers.recommendations.length === 0 && (
        <div className="rounded border p-4 text-sm" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <strong>Nothing on the wire helps.</strong> Of the {waivers.simulatedCount} best available
          players, none improves your title odds. Save the FAAB.
        </div>
      )}

      {waivers !== null && waivers.recommendations.length > 0 && (
        <>
          <table className="w-full text-left">
            <thead>
              <tr
                className="border-b text-xs uppercase tracking-widest"
                style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
              >
                <th className="py-2 font-semibold">Player</th>
                <th className="py-2 text-right font-semibold">Playoff Δ</th>
                <th className="py-2 text-right font-semibold">Title Δ</th>
                <th className="py-2 text-right font-semibold">Bid</th>
              </tr>
            </thead>
            <tbody>
              {waivers.recommendations.map((rec) => (
                <tr key={String(rec.candidate.playerId)} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                  <td className="py-3">
                    <span className="font-medium">{rec.candidate.name}</span>
                    <span className="ml-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {rec.candidate.position}
                    </span>
                    <div className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {rec.bidRationale}
                    </div>
                  </td>
                  <td className="tabular py-3 text-right" style={{ color: 'var(--ink-muted)' }}>
                    {pct(rec.delta.playoffDelta)}
                  </td>
                  <td
                    className="tabular py-3 text-right font-medium"
                    style={{ color: rec.delta.titleDelta > 0 ? 'var(--good)' : 'var(--bad)' }}
                  >
                    {pct(rec.delta.titleDelta)}
                  </td>
                  <td className="tabular py-3 text-right font-medium">${rec.suggestedBid}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-6 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            {waivers.simulatedCount} of {waivers.candidateCount} available players simulated — the
            rest cannot crack a lineup, so they cannot change your odds.{' '}
            {waivers.seasonBudget > 0
              ? `Bids size against your actual remaining FAAB ($${waivers.remainingBudget} of $${waivers.seasonBudget}), by this claim's share of the value still likely to appear this season.`
              : 'This league uses waiver priority rather than FAAB, so no bid is suggested.'}
          </p>
        </>
      )}
    </main>
    </>
  );
}
