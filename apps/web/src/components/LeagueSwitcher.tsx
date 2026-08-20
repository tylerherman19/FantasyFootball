'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * League switcher, pinned to the top-left of the content column.
 *
 * Managers run several leagues and compare them constantly, so which league you
 * are reading is the first thing on the page and switching is one click from
 * anywhere. It replaces a plain heading, which said the league name but made
 * changing it a trip back to the home page.
 */

export interface SwitcherLeague {
  readonly id: string;
  readonly name: string;
  readonly meta: string;
}

export const LeagueSwitcher = ({
  leagues,
  currentId,
  section,
}: {
  readonly leagues: readonly SwitcherLeague[];
  readonly currentId: string;
  /** Path suffix to preserve, so switching leagues keeps you on the same view. */
  readonly section: string;
}) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape, the way a menu is expected to behave.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = leagues.find((league) => league.id === currentId);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="group flex items-baseline gap-2 text-left"
      >
        <span className="display text-2xl leading-tight">{current?.name ?? 'League'}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3 w-3 shrink-0 transition-transform"
          style={{ color: 'var(--ink-faint)', transform: open ? 'rotate(180deg)' : 'none' }}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 w-72 border py-1 shadow-lg"
          style={{ borderColor: 'var(--rule-strong)', background: 'var(--surface)' }}
        >
          {leagues.map((league) => {
            const isCurrent = league.id === currentId;
            return (
              <li key={league.id} role="option" aria-selected={isCurrent}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    // Keep the reader on the same view in the new league.
                    router.push(`/league/${league.id}${section}`);
                  }}
                  className="block w-full px-3 py-2 text-left transition-colors hover:bg-[var(--surface-sunk)]"
                  style={{ background: isCurrent ? 'var(--surface-sunk)' : undefined }}
                >
                  <span className="block text-sm font-semibold">{league.name}</span>
                  <span className="block text-xs" style={{ color: 'var(--ink-faint)' }}>
                    {league.meta}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
