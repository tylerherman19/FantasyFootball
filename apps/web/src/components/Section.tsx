import type { ReactNode } from 'react';

/**
 * A titled block of data.
 *
 * Every section on every page announces itself the same way — label, one line
 * saying what the numbers mean, then the numbers. The note is not decoration:
 * a heat map of positional strength is unreadable until you know whether the
 * colour means points or rank, and putting that where the eye already is beats
 * a legend somewhere else.
 */
export const Section = ({
  title,
  note,
  aside,
  children,
  className = '',
}: {
  title: string;
  note?: ReactNode;
  /** Right-aligned in the heading row — a legend, a count, a caveat. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section className={`mb-9 ${className}`}>
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="eyebrow">{title}</h2>
      {aside}
    </div>
    {note !== undefined && (
      <p className="mb-3 max-w-3xl text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        {note}
      </p>
    )}
    {children}
  </section>
);

/**
 * One number, labelled.
 *
 * Deliberately plain: the value carries the weight, the label sits quiet above
 * it, and supporting context goes underneath in small type. Emphasis is a
 * colour shift rather than a size jump, so a row of tiles still scans as a row.
 */
export const StatTile = ({
  label,
  value,
  sub,
  emphasis = false,
  tone,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  emphasis?: boolean;
  tone?: 'good' | 'bad' | 'warn';
}) => (
  <div className="p-3" style={{ background: 'var(--surface)' }}>
    <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
      {label}
    </div>
    <div
      className="tabular mt-1 text-xl font-semibold sm:text-2xl"
      style={{
        color:
          tone === 'good'
            ? 'var(--good)'
            : tone === 'bad'
              ? 'var(--bad)'
              : tone === 'warn'
                ? 'var(--warn)'
                : emphasis
                  ? 'var(--accent)'
                  : 'var(--ink)',
      }}
    >
      {value}
    </div>
    {sub !== undefined && (
      <div className="tabular mt-0.5 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
        {sub}
      </div>
    )}
  </div>
);

/**
 * A row of tiles, hairline-separated by the grid gap showing the background
 * through. Two columns on a phone, `columns` from the small breakpoint up.
 */
const COLUMN_CLASS: Record<number, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-5',
  6: 'sm:grid-cols-6',
};

export const StatRow = ({ children, columns = 4 }: { children: ReactNode; columns?: number }) => (
  <div
    className={`grid grid-cols-2 gap-px overflow-hidden rounded border ${COLUMN_CLASS[columns] ?? 'sm:grid-cols-4'}`}
    style={{ borderColor: 'var(--rule)', background: 'var(--rule)' }}
  >
    {children}
  </div>
);
