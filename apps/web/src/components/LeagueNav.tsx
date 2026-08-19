import Link from 'next/link';
import { ThemeToggle } from './ThemeToggle';

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

const TABS = [
  { key: 'outlook', label: 'Outlook', href: '' },
  { key: 'power', label: 'Power', href: '/power' },
  { key: 'lineup', label: 'Lineup', href: '/lineup' },
  { key: 'waivers', label: 'Waivers', href: '/waivers' },
  { key: 'trades', label: 'Trades', href: '/trades' },
  { key: 'roster', label: 'Roster', href: '/roster' },
  { key: 'schedule', label: 'Schedule', href: '/schedule' },
  { key: 'usage', label: 'Usage', href: '/usage' },
] as const;

export const LeagueNav = ({ leagueId, leagueName, meta, active, lineupShape, stamps }: NavProps) => (
  <header
    className="sticky top-0 z-20 mb-6 border-b backdrop-blur"
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

          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight sm:text-2xl">{leagueName}</h1>

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

        <ThemeToggle />
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

      <nav className="scroll-x mt-3 flex gap-0.5">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={`/league/${leagueId}${tab.href}`}
              className="whitespace-nowrap px-2.5 py-2 text-[13px] transition-colors"
              style={{
                color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                fontWeight: isActive ? 600 : 400,
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  </header>
);
