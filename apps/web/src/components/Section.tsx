import type { ReactNode } from 'react';

/** A stable, URL-safe id from a section title. */
export const sectionId = (title: string): string =>
  `s-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;

/**
 * A titled block of data.
 *
 * Every section announces itself the same way — title, one line saying what the
 * numbers mean, then the numbers. The note is not decoration: a heat map of
 * positional strength is unreadable until you know whether the colour means
 * points or rank, and putting that where the eye already is beats a legend
 * somewhere else.
 *
 * **The title is a heading, not a label.** It used to render at the same weight
 * and size as the small-caps eyebrow used for field names, which flattened the
 * page: a section heading and a column header looked identical, so nothing
 * announced where one idea ended and the next began. It now takes the display
 * face at a real heading size, which is most of what separates an article from
 * a dashboard.
 *
 * Titles that state a finding — "Baltimore hands off inside the twenty" — read
 * better than ones that name a category, and `Figure` exists for the charts
 * where that is worth doing properly with a deck and a source line.
 */
export const Section = ({
  title,
  note,
  aside,
  source,
  children,
  className = '',
}: {
  title: string;
  note?: ReactNode;
  /** Right-aligned in the heading row — a legend, a count, a caveat. */
  aside?: ReactNode;
  /**
   * Where the numbers came from (§63).
   *
   * Every chart in the reference carries one, and it is not decoration: a
   * figure without a source is an assertion, and this product's entire claim is
   * that its numbers can be checked. It also does quiet work the prose cannot —
   * "2,000 season simulations" and "2024-25 play-by-play" are different kinds
   * of confidence, and a reader deserves to know which one they are looking at
   * without reading a methodology page.
   */
  source?: string;
  children: ReactNode;
  className?: string;
}) => (
  /*
   * The id is derived from the title so the scroll-following context bar can
   * observe sections without every page having to invent and thread ids. Slugs
   * are stable as long as titles are, and a title that changes is a section
   * whose context needed rewriting anyway.
   */
  <section id={sectionId(title)} className={`scroll-mt-40 mb-10 ${className}`}>
    <div className="section-heading mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2
        className="section-title leading-tight"
        style={{ fontSize: '1.15rem', fontWeight: 700, letterSpacing: '-0.016em' }}
      >
        {title}
      </h2>
      {aside}
    </div>
    {note !== undefined && (
      <details className="section-context mb-3">
        <summary>How to read this</summary>
        <div className="deck mt-1.5 max-w-3xl text-[0.82rem] leading-relaxed">{note}</div>
      </details>
    )}
    {children}
    {source !== undefined && <div className="source-line">Source: {source}</div>}
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
