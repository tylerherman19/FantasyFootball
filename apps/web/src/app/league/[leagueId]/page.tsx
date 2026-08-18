import Link from 'next/link';
import { OddsBar } from '@/components/OddsBar';
import { loadLeague } from '@/lib/league-data';

export const dynamic = 'force-dynamic';

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

const FORMAT_LABEL: Record<string, string> = {
  dynasty: 'Dynasty',
  keeper: 'Keeper',
  redraft: 'Redraft',
  guillotine: 'Guillotine',
};

export default async function LeaguePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);
  const { snapshot, result, teamNames, myTeamId } = view;
  const isGuillotine = snapshot.league.format === 'guillotine';

  // Before a draft every roster is empty, so any odds we produced would be an
  // artefact of tie-breaking rather than a forecast. Say so instead.
  const rosteredPlayers = snapshot.rosters.reduce((sum, r) => sum + r.playerIds.length, 0);
  const notDrafted = rosteredPlayers === 0;

  const standings = [...result.teams].sort((a, b) =>
    isGuillotine ? b.titlePct - a.titlePct : b.playoffPct - a.playoffPct || b.expectedWins - a.expectedWins,
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link href="/" className="text-sm hover:opacity-60" style={{ color: 'var(--ink-muted)' }}>
        ← leagues
      </Link>

      <header className="mt-4 mb-2">
        <h1 className="text-3xl font-semibold tracking-tight">{snapshot.league.name}</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--ink-muted)' }}>
          {FORMAT_LABEL[snapshot.league.format]} · {snapshot.league.teamCount} teams
          {snapshot.league.superFlex ? ' · superflex' : ''}
          {snapshot.league.medianWins ? ' · median wins' : ''} · week {snapshot.asOfWeek}
        </p>
      </header>

      <p className="mb-8 text-sm" style={{ color: 'var(--ink-muted)' }}>
        {result.iterations.toLocaleString()} simulated seasons
        {view.modelVersion !== null && ` · projections ${view.modelVersion}`}
      </p>

      {notDrafted && (
        <div
          className="mb-8 rounded border p-4 text-sm"
          style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
        >
          <strong>Not drafted yet.</strong> Every roster is empty, so there is nothing to
          simulate — any odds shown below would be an artefact of tie-breaking, not a forecast.
          This page becomes meaningful the moment the draft happens.
        </div>
      )}

      <table className="w-full text-left">
        <thead>
          <tr className="border-b text-xs uppercase tracking-widest" style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}>
            <th className="py-2 font-semibold">Team</th>
            <th className="py-2 text-right font-semibold">Proj. wins</th>
            <th className="py-2 pl-6 font-semibold">{isGuillotine ? 'Survives to end' : 'Playoffs'}</th>
            <th className="py-2 pl-6 text-right font-semibold">Title</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((team) => {
            const isMine = team.teamId === myTeamId;
            return (
              <tr
                key={team.teamId}
                className="border-b"
                style={{
                  borderColor: 'var(--rule)',
                  background: isMine ? 'var(--surface)' : undefined,
                }}
              >
                <td className="py-3 font-medium">
                  {teamNames.get(team.teamId) ?? team.teamId}
                  {isMine && (
                    <span className="ml-2 text-xs uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
                      you
                    </span>
                  )}
                </td>
                <td className="tabular py-3 text-right">{team.expectedWins.toFixed(1)}</td>
                <td className="py-3 pl-6">
                  <OddsBar
                    probability={isGuillotine ? team.titlePct : team.playoffPct}
                    iterations={result.iterations}
                  />
                </td>
                <td className="tabular py-3 pl-6 text-right">{(team.titlePct * 100).toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="mt-6 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        Bars show the estimate with its 95% simulation interval. A difference smaller than the band
        is noise, not news.
      </p>
    </main>
  );
}
