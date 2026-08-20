'use client';

import { usePathname } from 'next/navigation';
import { AppRail, ICONS, type RailItem } from './AppRail';
import { LeagueSwitcher, type SwitcherLeague } from './LeagueSwitcher';

/**
 * The frame every league view sits in: rail, switcher, league summary.
 *
 * This is a client component only so it can read the current path — which
 * section is active, and which section to preserve when switching leagues.
 * Everything it renders is static markup; no data is fetched here.
 */

const SECTIONS = [
  { key: 'outlook', label: 'Outlook', href: '', icon: ICONS.outlook },
  { key: 'lineup', label: 'Lineup', href: '/lineup', icon: ICONS.lineup },
  { key: 'waivers', label: 'Wire', href: '/waivers', icon: ICONS.waivers },
  { key: 'trades', label: 'Trades', href: '/trades', icon: ICONS.trades },
  { key: 'roster', label: 'Roster', href: '/roster', icon: ICONS.roster },
  { key: 'schedule', label: 'Sched', href: '/schedule', icon: ICONS.schedule },
] as const;

export const LeagueChrome = ({
  leagueId,
  leagues,
  meta,
  lineupShape,
  undrafted,
  children,
}: {
  readonly leagueId: string;
  readonly leagues: readonly SwitcherLeague[];
  readonly meta: string;
  readonly lineupShape: string;
  /** True when no roster in the league has a player yet. */
  readonly undrafted: boolean;
  readonly children: React.ReactNode;
}) => {
  const pathname = usePathname();
  const suffix = pathname.replace(`/league/${leagueId}`, '');

  const active =
    SECTIONS.find((section) => section.href !== '' && suffix.startsWith(section.href))?.key ??
    'outlook';

  const items: RailItem[] = SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    href: `/league/${leagueId}${section.href}`,
    icon: section.icon,
  }));

  return (
    <>
      <AppRail items={items} active={active} />

      <div className="pl-14">
        <header className="border-b px-6 pb-3 pt-5" style={{ borderColor: 'var(--rule)' }}>
          <LeagueSwitcher
            leagues={leagues}
            currentId={leagueId}
            section={SECTIONS.find((s) => s.key === active)?.href ?? ''}
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
            {meta} · starters {lineupShape}
          </p>
        </header>

        {/*
         * An undrafted league has no rosters, so every downstream number is
         * empty. Saying so once, at the top, is the difference between a tool
         * that looks broken and one that is simply early — this league renders
         * blank tables in August because nobody owns a player yet.
         */}
        {undrafted && (
          <div
            className="mx-6 mt-4 border-l-2 px-3 py-2 text-sm"
            style={{ borderColor: 'var(--accent)', background: 'var(--surface-sunk)' }}
          >
            <strong className="display">This league hasn&apos;t drafted.</strong>{' '}
            <span style={{ color: 'var(--ink-muted)' }}>
              Every roster is empty, so there is nothing yet to project, trade or claim. Analysis
              appears here once picks are in.
            </span>
          </div>
        )}

        <main className="px-6 pb-24 pt-6">{children}</main>
      </div>
    </>
  );
};
