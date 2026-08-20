import Link from 'next/link';

/**
 * The fixed left rail.
 *
 * Navigation belongs at the edge of the screen, not in the reading column: the
 * charts and tables are the widest things here and they need the full width.
 * Keeping the rail narrow and always-present also means the league you are
 * looking at is never more than one click from any other view.
 */

export interface RailItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  /** Inline SVG path data, drawn on a 24×24 grid. */
  readonly icon: React.ReactNode;
}

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-[18px] w-[18px]"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const ICONS = {
  outlook: (
    <Icon>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-5 3 3 5-7" />
    </Icon>
  ),
  lineup: (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M9 4v16" />
    </Icon>
  ),
  waivers: (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  trades: (
    <Icon>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </Icon>
  ),
  roster: (
    <Icon>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0M17 11h4M17 15h4" />
    </Icon>
  ),
  schedule: (
    <Icon>
      <rect x="3" y="5" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </Icon>
  ),
  matchups: (
    <Icon>
      <path d="M12 3v18" />
      <circle cx="7" cy="8" r="2.5" />
      <circle cx="17" cy="16" r="2.5" />
    </Icon>
  ),
  leagues: (
    <Icon>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </Icon>
  ),
} as const;

export const AppRail = ({
  items,
  active,
}: {
  readonly items: readonly RailItem[];
  readonly active: string;
}) => (
  <nav
    aria-label="Sections"
    className="fixed left-0 top-0 z-20 flex h-full w-14 flex-col items-center border-r py-3"
    style={{ borderColor: 'var(--rule)', background: 'var(--surface-sunk)' }}
  >
    <Link
      href="/"
      aria-label="All leagues"
      className="mb-3 flex h-8 w-8 items-center justify-center rounded-sm"
      style={{ background: 'var(--ink)', color: '#fff' }}
    >
      <span className="display text-[13px] leading-none">FE</span>
    </Link>

    {items.map((item) => {
      const isActive = item.key === active;
      return (
        <Link
          key={item.key}
          href={item.href}
          aria-current={isActive ? 'page' : undefined}
          className="group relative mb-0.5 flex w-full flex-col items-center gap-0.5 py-2 transition-colors"
          style={{ color: isActive ? 'var(--ink)' : 'var(--ink-faint)' }}
        >
          {/* The active marker is a rule, not a fill — quieter, and it reads. */}
          <span
            aria-hidden="true"
            className="absolute left-0 top-0 h-full w-[2px]"
            style={{ background: isActive ? 'var(--accent)' : 'transparent' }}
          />
          {item.icon}
          <span className="text-[9px] font-semibold uppercase tracking-wider">{item.label}</span>
        </Link>
      );
    })}
  </nav>
);
