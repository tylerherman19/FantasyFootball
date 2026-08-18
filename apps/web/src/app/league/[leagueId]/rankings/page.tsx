import { LeagueNav } from '@/components/LeagueNav';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { leagueRankings } from '@/lib/rankings';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

const SIGNAL_COPY: Record<string, string> = {
  stranded: 'Roster is worth more than the season it is producing.',
  overachieving: 'Odds are running ahead of the roster.',
  aligned: '',
};

/** Rank movement between two of the three measures, as a signed chip. */
const Divergence = ({ value }: { value: number }) => {
  if (value === 0) return <span style={{ color: 'var(--ink-faint)' }}>—</span>;

  return (
    <span
      className="tabular font-medium"
      style={{ color: value > 0 ? 'var(--good)' : 'var(--bad)' }}
    >
      {value > 0 ? '+' : ''}
      {value}
    </span>
  );
};

export default async function RankingsPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);
  const { snapshot, myTeamId } = view;

  const players = await loadPlayerInfo(
    snapshot.league.season,
    snapshot.asOfWeek,
    snapshot.league.scoring.raw,
  );
  const { teams, hasMarketValues, notDrafted } = await leagueRankings(view, players);

  const anyPlayed = teams.some((team) => (team.luck?.weeksPlayed ?? 0) > 0);
  const luckiest = [...teams]
    .filter((team) => team.luck !== null)
    .sort((a, b) => Math.abs(b.luck!.luck) - Math.abs(a.luck!.luck))
    .slice(0, 4);

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="rankings"
        format={snapshot.league.format}
      />

      <main className="mx-auto max-w-5xl px-6 pb-20">
        <p className="mb-8 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          Three rankings, kept separate on purpose. Averaging them into one number would hide the
          only interesting thing here — a roster can be the most valuable in the league and the
          fifth-likeliest to win it, and that gap is the finding.
        </p>

        {notDrafted && (
          <div
            className="mb-8 rounded border p-4 text-sm"
            style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
          >
            <strong>Not drafted yet.</strong> Every roster is empty, so there is nothing to rank.
            These columns fill in the moment the draft happens.
          </div>
        )}

        {!hasMarketValues && !notDrafted && (
          <div
            className="mb-8 rounded border p-4 text-sm"
            style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
          >
            <strong>Market values unavailable.</strong> FantasyCalc did not respond, so the value
            column and every divergence based on it are omitted rather than guessed.
          </div>
        )}

        <section className="mb-10">
          <div className="scroll-x">
            <table className="w-full min-w-[44rem] text-left">
              <thead>
                <tr
                  className="border-b text-xs uppercase tracking-widest"
                  style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}
                >
                  <th className="py-2">#</th>
                  <th className="py-2">Team</th>
                  {hasMarketValues && <th className="py-2 text-right">Value</th>}
                  <th className="py-2 text-right">Proj. wins</th>
                  <th className="py-2 text-right">Title</th>
                  {hasMarketValues && (
                    <th className="py-2 pl-6 text-right" title="Value rank minus title-odds rank">
                      Gap
                    </th>
                  )}
                  <th className="py-2 pl-6 text-right">VORP</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((team, index) => {
                  const isMine = team.teamId === myTeamId;
                  const { ranking } = team;

                  return (
                    <tr key={team.teamId} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                      <td className="tabular py-3 pr-2 text-sm" style={{ color: 'var(--ink-faint)' }}>
                        {index + 1}
                      </td>
                      <td className="py-3" style={{ fontWeight: isMine ? 600 : 400 }}>
                        {team.teamName}
                        {isMine && (
                          <span
                            className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest"
                            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                          >
                            you
                          </span>
                        )}
                        {SIGNAL_COPY[ranking.signal] !== '' && (
                          <div className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
                            {SIGNAL_COPY[ranking.signal]}
                          </div>
                        )}
                      </td>
                      {hasMarketValues && (
                        <td className="tabular py-3 text-right text-sm">
                          {ranking.marketValue.toLocaleString()}
                          <span className="ml-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                            #{ranking.valueRank}
                          </span>
                        </td>
                      )}
                      <td className="tabular py-3 text-right text-sm">
                        {ranking.expectedWins.toFixed(1)}
                        <span className="ml-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                          #{ranking.winsRank}
                        </span>
                      </td>
                      <td className="tabular py-3 text-right text-sm">
                        {(ranking.titlePct * 100).toFixed(1)}%
                        <span className="ml-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                          #{ranking.titleRank}
                        </span>
                      </td>
                      {hasMarketValues && (
                        <td className="py-3 pl-6 text-right text-sm">
                          <Divergence value={ranking.divergence} />
                        </td>
                      )}
                      <td className="tabular py-3 pl-6 text-right text-sm" style={{ color: 'var(--ink-muted)' }}>
                        {team.scarcity.total.toFixed(0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {hasMarketValues && (
              <>
                Gap is value rank minus title-odds rank. Positive means the odds are better than the
                roster; negative means the roster is being wasted.{' '}
              </>
            )}
            VORP totals this team&apos;s starters above <em>this</em> league&apos;s replacement
            level, flex slots included.
          </p>
        </section>

        {anyPlayed && (
          <section className="mb-10">
            <h2
              className="mb-1 text-xs font-semibold uppercase tracking-widest"
              style={{ color: 'var(--ink-faint)' }}
            >
              Schedule luck
            </h2>
            <p className="mb-3 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
              Every team&apos;s scores replayed against the whole league each week. The gap between
              the record they have and the record they earned is the schedule, not the team.
            </p>

            <div className="scroll-x">
              <table className="w-full min-w-[36rem] text-left">
                <thead>
                  <tr
                    className="border-b text-xs uppercase tracking-widest"
                    style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-faint)' }}
                  >
                    <th className="py-2">Team</th>
                    <th className="py-2 text-right">Actual</th>
                    <th className="py-2 text-right">Earned</th>
                    <th className="py-2 text-right">Luck</th>
                    <th className="py-2 pl-6 text-right">Best / worst schedule</th>
                  </tr>
                </thead>
                <tbody>
                  {luckiest.map((team) => {
                    const luck = team.luck!;
                    return (
                      <tr key={team.teamId} className="border-b" style={{ borderColor: 'var(--rule)' }}>
                        <td className="py-3" style={{ fontWeight: team.teamId === myTeamId ? 600 : 400 }}>
                          {team.teamName}
                        </td>
                        <td className="tabular py-3 text-right text-sm">{luck.actualWins.toFixed(1)}</td>
                        <td className="tabular py-3 text-right text-sm" style={{ color: 'var(--ink-muted)' }}>
                          {luck.expectedWins.toFixed(1)}
                        </td>
                        <td
                          className="tabular py-3 text-right text-sm font-medium"
                          style={{ color: luck.luck >= 0 ? 'var(--good)' : 'var(--bad)' }}
                        >
                          {luck.luck >= 0 ? '+' : ''}
                          {luck.luck.toFixed(1)}
                        </td>
                        <td className="tabular py-3 pl-6 text-right text-sm" style={{ color: 'var(--ink-faint)' }}>
                          {luck.bestScheduleWins.toFixed(0)} / {luck.worstScheduleWins.toFixed(0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section>
          <h2
            className="mb-1 text-xs font-semibold uppercase tracking-widest"
            style={{ color: 'var(--ink-faint)' }}
          >
            Lineup efficiency
          </h2>
          <p className="mb-3 max-w-2xl text-sm" style={{ color: 'var(--ink-muted)' }}>
            Points scored divided by the best legal lineup each week. This is the number the
            simulator uses for each manager, rather than assuming everyone is perfect.
          </p>

          <ul className="divide-y rounded border" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
            {[...teams]
              .sort((a, b) => b.efficiency - a.efficiency)
              .map((team) => (
                <li key={team.teamId} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm" style={{ fontWeight: team.teamId === myTeamId ? 600 : 400 }}>
                    {team.teamName}
                    {team.efficiencyImputed && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                        league average — not enough games yet
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-4">
                    {!team.efficiencyImputed && team.pointsLost > 0 && (
                      <span className="tabular text-xs" style={{ color: 'var(--ink-faint)' }}>
                        {team.pointsLost.toFixed(0)} left on the bench
                      </span>
                    )}
                    <span className="tabular w-14 text-right text-sm font-semibold">
                      {(team.efficiency * 100).toFixed(1)}%
                    </span>
                  </span>
                </li>
              ))}
          </ul>
        </section>
      </main>
    </>
  );
}
