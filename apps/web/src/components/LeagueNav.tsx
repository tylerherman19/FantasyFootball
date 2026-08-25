import Link from 'next/link';
import { AppRail, ICONS } from './AppRail';
import { Freshness } from './Freshness';
import { LeagueSwitcher } from './LeagueSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { listLeagues } from '@/lib/league-data';
import { loadLatestArtifact } from '@/lib/projections';
import { readFreshness } from '@/lib/refresh-runner';
import { defaultSeason, readSession } from '@/lib/session';

/**
 * League-scoped navigation.
 *
 * Everything in this product is per-league — a redraft league shouldn't show
 * pick equity, a guillotine league has no playoff bracket — so the nav carries
 * the league with it rather than sitting above it.
 *
 * The header is sticky and collapses to the tab strip as you scroll. On a data
 * page you are constantly moving between views of the same league, and a header
 * that scrolls away costs a trip to the top of the document every time.
 */

export interface NavProps {
  readonly leagueId: string;
  readonly leagueName: string;
  readonly meta: string;
  readonly active: string;
  readonly format: string;
  /** Parsed starting slots, shown so the detection is auditable. */
  readonly lineupShape?: string;
  /** Facts worth pinning next to the title, as label/value pairs. */
  readonly stamps?: readonly { readonly label: string; readonly value: string }[];
}

const VIEWS = [
  { key: 'outlook', label: 'Overview', href: '', group: 'overview' },
  { key: 'lineup', label: 'Lineup', href: '/lineup', group: 'week' },
  { key: 'scheme', label: 'Matchups', href: '/scheme', group: 'week' },
  { key: 'waivers', label: 'Waivers', href: '/waivers', group: 'improve' },
  { key: 'trades', label: 'Trades', href: '/trades', group: 'improve' },
  { key: 'roster', label: 'Roster', href: '/roster', group: 'team' },
  { key: 'dynasty', label: 'Strategy', href: '/dynasty', group: 'team' },
  { key: 'usage', label: 'Usage', href: '/usage', group: 'team' },
  { key: 'power', label: 'Power', href: '/power', group: 'league' },
  { key: 'schedule', label: 'Schedule', href: '/schedule', group: 'league' },
] as const;

const PRIMARY = [
  { key: 'overview', label: 'Overview', href: '', icon: ICONS.outlook },
  { key: 'week', label: 'This week', href: '/lineup', icon: ICONS.lineup },
  { key: 'improve', label: 'Improve', href: '/waivers', icon: ICONS.waivers },
  { key: 'team', label: 'Team', href: '/roster', icon: ICONS.roster },
  { key: 'league', label: 'League', href: '/power', icon: ICONS.power },
] as const;

export const LeagueNav = async ({
  leagueId,
  leagueName,
  meta,
  active,
  lineupShape,
  stamps,
}: NavProps) => {
  /*
   * Every league the signed-in manager runs, offered from the title itself.
   *
   * Switching used to mean going back to the index and coming in again, which
   * is a strange amount of friction for the thing people do most: comparing the
   * same view across their leagues. The list is already cached, so this costs
   * nothing, and picking one keeps you on the tab you were reading.
   */
  const session = await readSession();
  const leagues =
    session === null ? [] : await listLeagues(session.username, session.season).catch(() => []);

  /*
   * Freshness rides in the header rather than living on a page of its own.
   *
   * The application had no way to say how old its numbers were, while the job
   * that was supposed to refresh them had never once succeeded. A status page
   * would not have caught that, because nobody visits a status page. This is in
   * the corner of every screen instead, and it is allowed to fail quietly — a
   * freshness widget must never be the reason a league page does not render.
   */
  const artifact = await loadLatestArtifact(session?.season ?? defaultSeason()).catch(() => null);
  const sources = await readFreshness(artifact?.generatedAt ?? null).catch(() => []);

  const options = leagues.map((league) => ({
    id: league.platformLeagueId,
    name: league.name,
    meta: [league.format, league.teamCount === undefined ? null : `${league.teamCount} teams`]
      .filter((part): part is string => part != null)
      .join(' · '),
  }));

  const activeView = VIEWS.find((view) => view.key === active) ?? VIEWS[0];
  const activeGroup = activeView.group;
  const subviews = VIEWS.filter((view) => view.group === activeGroup);

  /*
   * The rail carries navigation at the edge of the screen, where it belongs on
   * a page whose content is wide tables and charts — a horizontal strip spends
   * vertical space on every view and pushes the first number below the fold.
   * The strip stays for narrow screens, where a fixed rail would eat width the
   * tables need more.
   */
  const railItems = PRIMARY.map((item) => ({
    key: item.key,
    label: item.label,
    href: `/league/${leagueId}${item.href}`,
    icon: item.icon,
  }));

  return (
  <>
    <div className="hidden lg:block">
      <AppRail items={railItems} active={active} />
    </div>

    <header
    data-league-nav
    className="sticky top-0 z-20 mb-6 border-b backdrop-blur lg:ml-14"
    style={{ borderColor: 'var(--rule)', background: 'color-mix(in srgb, var(--ground) 88%, transparent)' }}
  >
    <div className="mx-auto max-w-6xl px-5 pt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/"
            className="text-[11px] uppercase tracking-widest hover:opacity-60"
            style={{ color: 'var(--ink-faint)' }}
          >
            ← All leagues
          </Link>

          <div className="mt-1">
            {options.length > 1 ? (
              <LeagueSwitcher
                leagues={options}
                currentId={leagueId}
                section={activeView.href}
              />
            ) : (
              <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
                {leagueName}
              </h1>
            )}
          </div>

          <p className="tabular mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
            {meta}
            {lineupShape !== undefined && (
              <>
                {' · '}
                <span style={{ color: 'var(--ink-faint)' }}>{lineupShape}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <Freshness sources={sources} modelGeneratedAt={artifact?.generatedAt ?? null} />
          <ThemeToggle />
        </div>
      </div>

      {stamps !== undefined && stamps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {stamps.map((stamp) => (
            <span key={stamp.label} className="tabular text-[11px]" style={{ color: 'var(--ink-faint)' }}>
              {stamp.label} <strong style={{ color: 'var(--ink-muted)' }}>{stamp.value}</strong>
            </span>
          ))}
        </div>
      )}

      {/*
        * One navigation at a time.
        *
        * The rail and this strip are the same ten links, and showing both at
        * desktop width is the kind of duplication that makes a page feel
        * cluttered without adding a single thing a reader can do. The strip is
        * for narrow screens, where a fixed rail would take width the tables
        * need more.
        */}
      <nav className="scroll-x mt-3 flex gap-0.5 lg:hidden" aria-label="League sections">
        {PRIMARY.map((item) => {
          const isActive = item.key === activeGroup;
          return (
            <Link
              key={item.key}
              href={`/league/${leagueId}${item.href}`}
              className="whitespace-nowrap px-2.5 py-2 text-[13px] transition-colors"
              style={{
                color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                fontWeight: isActive ? 600 : 400,
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {subviews.length > 1 && (
        <nav className="scroll-x flex gap-4 border-t py-1.5" style={{ borderColor: 'var(--rule)' }} aria-label={`${PRIMARY.find((item) => item.key === activeGroup)?.label ?? 'Section'} views`}>
          {subviews.map((view) => (
            <Link
              key={view.key}
              href={`/league/${leagueId}${view.href}`}
              aria-current={view.key === active ? 'page' : undefined}
              className="whitespace-nowrap text-[11px] font-medium"
              style={{ color: view.key === active ? 'var(--accent)' : 'var(--ink-faint)' }}
            >
              {view.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  </header>
  </>
  );
};
