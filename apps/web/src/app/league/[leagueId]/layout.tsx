import { LeagueChrome } from '@/components/LeagueChrome';
import { leagueMeta, lineupShape, listLeagues, loadLeague } from '@/lib/league-data';

/**
 * Chrome for every league view.
 *
 * Each page used to render its own header and tab bar, which meant six copies
 * of the same markup and six chances for them to drift. The league load here is
 * memoized and shared with the page itself, so hoisting it costs nothing.
 */

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';
const SEASON = Number(process.env.SEASON ?? new Date().getFullYear());

export default async function LeagueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;

  const [view, leagues] = await Promise.all([
    loadLeague(leagueId, USERNAME),
    listLeagues(USERNAME, SEASON),
  ]);

  // The league list carries only identity, so the row subtitle names the
  // platform and season rather than inventing a format it doesn't know.
  const switcherLeagues = leagues.map((league) => ({
    id: league.platformLeagueId,
    name: league.name,
    meta: `${league.platform} · ${league.season}`,
  }));

  const undrafted = view.snapshot.rosters.every((roster) => roster.playerIds.length === 0);

  return (
    <LeagueChrome
      leagueId={leagueId}
      leagues={switcherLeagues}
      meta={leagueMeta(view.snapshot)}
      lineupShape={lineupShape(view.snapshot)}
      undrafted={undrafted}
    >
      {children}
    </LeagueChrome>
  );
}
