import { StatTile } from '@/components/StatTile';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { analyzeRoster } from '@/lib/roster-analysis';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

const VERDICT_COLOR: Record<string, string> = {
  thin: 'var(--neg)',
  balanced: 'var(--ink-muted)',
  surplus: 'var(--pos)',
};

export default async function RosterPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);
  const { snapshot, myTeamId } = view;

  const analysis = myTeamId === null ? null : await analyzeRoster(view, myTeamId);
  const isDynasty = snapshot.league.format === 'dynasty' || snapshot.league.format === 'keeper';

  return (
    <>

      <>
        {analysis === null && (
          <p style={{ color: 'var(--ink-muted)' }}>No roster analysis available for this league yet.</p>
        )}

        {analysis !== null && (
          <>
            <section className="mb-10">
              <div
                className="grid grid-cols-2 gap-px overflow-hidden rounded border sm:grid-cols-4"
                style={{ borderColor: 'var(--rule)', background: 'var(--rule)' }}
              >
                <StatTile label="Starting lineup" value={analysis.lineupTotal.toFixed(1)} sub="projected points" />
                <StatTile
                  label="Top-two reliance"
                  value={`${(analysis.topTwoShare * 100).toFixed(0)}%`}
                  sub="of your lineup"
                  emphasis={analysis.topTwoShare > 0.35}
                />
                <StatTile
                  label="Starter age"
                  value={analysis.averageStarterAge === null ? '—' : analysis.averageStarterAge.toFixed(1)}
                  sub={isDynasty ? 'contention window' : 'informational'}
                />
                <StatTile
                  label="Thin at"
                  value={
                    analysis.depth.filter((d) => d.verdict === 'thin').map((d) => d.position).join(', ') ||
                    'nothing'
                  }
                />
              </div>
              <p className="mt-3 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
                Top-two reliance is the fragility measure: a team drawing more than a third of its
                points from two players is one injury from collapse, whatever its record says.
              </p>
            </section>

            <section className="mb-10">
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
                Who is carrying this team
              </h2>
              <p className="mb-3 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
                Sorted by what the lineup loses without each player — not by projection. Someone who
                projects well but sits behind a better player contributes nothing.
              </p>

              <div className="scroll-x">
                <table className="w-full min-w-[38rem] text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase tracking-widest"
                      style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}>
                      <th className="py-2">Player</th>
                      <th className="py-2">Status</th>
                      <th className="py-2 text-right">Age</th>
                      <th className="py-2 text-right">Projects</th>
                      <th className="py-2 text-right">Lineup loses</th>
                      <th className="py-2 text-right">Market</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.players.map((player) => (
                      <tr key={player.playerId} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                        <td className="py-2">
                          <span style={{ fontWeight: player.starting ? 600 : 400 }}>{player.name}</span>
                          <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                            {player.position} {player.team}
                          </span>
                        </td>
                        <td
                          className="py-2 text-xs"
                          style={{ color: player.injuryStatus === null ? 'var(--ink-faint)' : 'var(--neg)' }}
                        >
                          {player.injuryStatus ?? (player.starting ? 'starting' : 'bench')}
                        </td>
                        <td className="tabular py-2 text-right" style={{ color: 'var(--ink-muted)' }}>
                          {player.age === null ? '—' : player.age.toFixed(1)}
                        </td>
                        <td className="tabular py-2 text-right">{player.projected.toFixed(1)}</td>
                        <td
                          className="tabular py-2 text-right font-medium"
                          style={{ color: player.marginal < 1 ? 'var(--ink-faint)' : 'var(--ink)' }}
                        >
                          {player.marginal < 0.05 ? '—' : `−${player.marginal.toFixed(1)}`}
                        </td>
                        <td className="tabular py-2 text-right" style={{ color: 'var(--ink-muted)' }}>
                          {player.marketValue > 0 ? player.marketValue.toLocaleString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="grid gap-8 sm:grid-cols-2">
              {analysis.sellCandidates.length > 0 && (
                <section>
                  <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
                    Sell candidates
                  </h2>
                  <p className="mb-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
                    The market pays for them; your lineup doesn&apos;t need them.
                  </p>
                  <ul>
                    {analysis.sellCandidates.map((player) => (
                      <li
                        key={player.playerId}
                        className="flex justify-between gap-3 border-b py-2 text-sm"
                        style={{ borderColor: 'var(--rule)' }}
                      >
                        <span>
                          {player.name}
                          <span className="ml-1.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
                            {player.position}
                          </span>
                        </span>
                        <span className="tabular shrink-0" style={{ color: 'var(--pos)' }}>
                          {player.marketValue.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {analysis.undervalued.length > 0 && (
                <section>
                  <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
                    Worth more to you than to the market
                  </h2>
                  <p className="mb-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
                    Cheap in market terms for what they do here. Keep, or buy more like them.
                  </p>
                  <ul>
                    {analysis.undervalued.map((player) => (
                      <li
                        key={player.playerId}
                        className="flex justify-between gap-3 border-b py-2 text-sm"
                        style={{ borderColor: 'var(--rule)' }}
                      >
                        <span>
                          {player.name}
                          <span className="ml-1.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
                            {player.position}
                          </span>
                        </span>
                        <span className="tabular shrink-0" style={{ color: 'var(--ink-muted)' }}>
                          {player.valuePerPoint === null ? '—' : `${Math.round(player.valuePerPoint)} / pt`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            <section className="mt-10">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
                Depth by position
              </h2>
              <div className="scroll-x">
                <table className="w-full min-w-[28rem] text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase tracking-widest"
                      style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}>
                      <th className="py-2">Position</th>
                      <th className="py-2">Verdict</th>
                      <th className="py-2 text-right">Lineup leans on it</th>
                      <th className="py-2 text-right">If top player lost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...analysis.depth]
                      .sort((a, b) => b.totalMarginal - a.totalMarginal)
                      .map((entry) => (
                        <tr key={entry.position} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                          <td className="py-2 font-medium">{entry.position}</td>
                          <td className="py-2 font-medium" style={{ color: VERDICT_COLOR[entry.verdict] }}>
                            {entry.verdict}
                          </td>
                          <td className="tabular py-2 text-right">{entry.totalMarginal.toFixed(1)}</td>
                          <td className="tabular py-2 text-right" style={{ color: 'var(--ink-muted)' }}>
                            −{entry.exposureToTopLoss.toFixed(1)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </>
    </>
  );
}
