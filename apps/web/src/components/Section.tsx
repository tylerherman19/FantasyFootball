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
/**
 * A labelled statistic.
 *
 * Retained as the name eight pages already call, but re-implemented on the
 * design-system presentation rather than its own. That is what a shared
 * vocabulary is supposed to buy: the older pages migrate by having their
 * primitive change underneath them, not by having their JSX rewritten.
 *
 * Two things changed in the move, both from the brief:
 *
 * - **The surface is gone** (§74). Every statistic used to sit on its own
 *   filled panel inside a hairline grid, which is a card per number by another
 *   name. Hierarchy now comes from type and rules.
 * - **`sub` is where context goes** (§67), and its absence is now visible
 *   rather than invisible — a tile with no context renders a thin em dash line
 *   instead of silently looking finished, so the gap shows up in review.
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
  <div className="py-1">
    <div className="eyebrow mb-1">{label}</div>
    <div
      className="figure text-xl font-semibold sm:text-2xl"
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
    <div className="tabular mt-0.5 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
      {sub ?? '—'}
    </div>
  </div>
);

/**
 * A row of statistics, separated by whitespace rather than boxed.
 *
 * Was a hairline grid with the background showing through the gaps, which drew
 * a box around every number on the page — the thing §74 rules out. Same API,
 * same responsive column counts, no rectangles.
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
    className={`grid grid-cols-2 gap-x-8 gap-y-4 border-t pt-4 ${COLUMN_CLASS[columns] ?? 'sm:grid-cols-4'}`}
    style={{ borderColor: 'var(--rule)' }}
  >
    {children}
  </div>
);
