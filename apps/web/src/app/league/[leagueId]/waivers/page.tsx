import { LeagueNav } from '@/components/LeagueNav';
import { WaiverBoard } from '@/components/WaiverBoard';
import { loadLeague, leagueMeta, lineupShape } from '@/lib/league-data';
import { loadPlayerInfo } from '@/lib/players';
import { loadFreeAgents, waiverBudgetFor } from '@/lib/waiver-data';
import { serializeLeague } from '@/lib/serialize';
import { loadMarketValues } from '@/lib/values';

export const revalidate = 900;

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';

export default async function WaiversPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const view = await loadLeague(leagueId, USERNAME);

  if (view.myTeamId === null) {
    return <main className="mx-auto max-w-5xl px-6 py-12">Could not find your team in this league.</main>;
  }

  const myTeamId = view.myTeamId;
  const { snapshot } = view;

  const [values, players, freeAgents] = await Promise.all([
    loadMarketValues(snapshot.league.format, snapshot.league.superFlex),
    loadPlayerInfo(snapshot.league.season, snapshot.asOfWeek, snapshot.league.scoring.raw),
    loadFreeAgents(view),
  ]);

  const wire = serializeLeague(
    view,
    values,
    players,
    [],
    freeAgents,
    waiverBudgetFor(snapshot, myTeamId),
  );

  return (
    <>
      <LeagueNav
        leagueId={leagueId}
        leagueName={snapshot.league.name}
        meta={leagueMeta(snapshot)}
        lineupShape={lineupShape(snapshot)}
        active="waivers"
        format={snapshot.league.format}
      />

      <main className="mx-auto max-w-5xl px-6 pb-20">
        <p className="mb-6 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          Ranked by what each player does to <em>your</em> title odds, not by projected points. A
          backup running back is worth a lot to the manager whose starter just went down and nothing
          to everyone else — same player, same projection. Choose what you&apos;re willing to drop and
          the board re-ranks against that.
        </p>

        <WaiverBoard league={wire} myTeamId={myTeamId} />
      </main>
    </>
  );
}
