import Link from 'next/link';

/**
 * League-scoped navigation.
 *
 * Everything in this product is per-league — a redraft league shouldn't show
 * pick equity, a guillotine league has no playoff bracket — so the nav carries
 * the league with it rather than sitting above it.
 */

export interface NavProps {
  readonly leagueId: string;
  readonly leagueName: string;
  readonly meta: string;
  readonly active: string;
  readonly format: string;
  /** Parsed starting slots, shown so the detection is auditable. */
  readonly lineupShape?: string;
}

const TABS = [
  { key: 'outlook', label: 'Outlook', href: '' },
  { key: 'lineup', label: 'Lineup', href: '/lineup' },
  { key: 'waivers', label: 'Waivers', href: '/waivers' },
  { key: 'trades', label: 'Trades', href: '/trades' },
  { key: 'rankings', label: 'Rankings', href: '/rankings' },
  { key: 'roster', label: 'Roster', href: '/roster' },
  { key: 'schedule', label: 'Schedule', href: '/schedule' },
] as const;

export const LeagueNav = ({ leagueId, leagueName, meta, active, lineupShape }: NavProps) => (
  <header className="mb-8 border-b" style={{ borderColor: 'var(--rule)' }}>
    <div className="mx-auto max-w-5xl px-6 pt-6">
      <Link href="/" className="text-xs uppercase tracking-widest hover:opacity-60" style={{ color: 'var(--ink-faint)' }}>
        Fantasy Football Edge
      </Link>

      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{leagueName}</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--ink-muted)' }}>
        {meta}
      </p>
      {lineupShape !== undefined && (
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Starters: {lineupShape}
        </p>
      )}

      <nav className="scroll-x mt-5 flex gap-1">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={`/league/${leagueId}${tab.href}`}
              className="whitespace-nowrap px-3 py-2 text-sm transition-colors"
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
