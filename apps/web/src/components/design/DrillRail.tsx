import type { ReactNode } from 'react';

/**
 * The right-hand panel (§62, §86).
 *
 * The brief asks for it explicitly: navigation on the left, primary analysis in
 * the centre, model explanation and context on the right. Two things were wrong
 * without it. Roughly five hundred pixels of every desktop screen were empty,
 * and — the real cost — the answer to "why does the model think that" lived one
 * page away instead of beside the number it explains.
 *
 * A reader checking a projection should not have to leave the page they are
 * checking it on. That is the whole idea behind drill-down: the evidence sits
 * next to the claim, not behind a link.
 *
 * Sticky, because the rail is context for whatever is on screen and scrolling
 * away from it defeats the point.
 *
 * **On a phone it is not a rail at all.** A 19rem column with nowhere to go
 * used to collapse into a wall of grey text below everything on the page, which
 * is not "the same evidence, just not beside anything" — it is evidence nobody
 * scrolls to. Two things replace it. `ContextBar` carries the live part at the
 * top, following the reader down the page at every width; and what remains
 * folds into a disclosure at the end, open to anyone who wants it and costing a
 * single line to anyone who does not.
 *
 * The bar is mounted here rather than per page on purpose: eight pages use this
 * layout, and eight separate wirings would have been eight chances to forget
 * one.
 */
export const RailLayout = ({
  children,
  rail,
}: {
  readonly children: ReactNode;
  readonly rail: ReactNode;
}) => (
  <div className="mx-auto max-w-[92rem] px-5 lg:pl-[4.75rem]">
    <div className="lg:flex lg:gap-10">
      <div className="min-w-0 flex-1 pb-8 lg:pb-20">
        {children}

        {/* Phone and tablet: the rail's material, folded away but reachable. */}
        <details className="mt-4 border-t pt-3 lg:hidden" style={{ borderColor: 'var(--rule)' }}>
          <summary
            className="eyebrow cursor-pointer select-none py-1"
            style={{ color: 'var(--accent)' }}
          >
            How this was computed, and what the model declined
          </summary>
          <div className="mt-3">{rail}</div>
        </details>
      </div>

      <aside className="hidden shrink-0 pb-20 lg:block lg:w-[19rem]">
        <div className="lg:sticky lg:top-[7.5rem]">{rail}</div>
      </aside>
    </div>
  </div>
);

/**
 * One block of context in the rail.
 *
 * Quieter than the main column on purpose — this is the apparatus, not the
 * argument. If it competed for attention it would be a second page rather than
 * a margin.
 */
export const RailBlock = ({
  title,
  children,
  note,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly note?: ReactNode;
}) => (
  <section className="mb-7 border-t pt-3" style={{ borderColor: 'var(--rule)' }}>
    <h3 className="eyebrow mb-2">{title}</h3>
    <div className="text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
      {children}
    </div>
    {note !== undefined && (
      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        {note}
      </p>
    )}
  </section>
);

/** A labelled figure in the rail, aligned so a column of them scans. */
export const RailStat = ({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}) => (
  <div
    className="flex items-baseline justify-between gap-3 border-t py-1.5 first:border-t-0"
    style={{ borderColor: 'var(--rule)' }}
    title={hint}
  >
    <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
      {label}
    </span>
    <span className="figure text-sm font-medium" style={{ color: 'var(--ink)' }}>
      {value}
    </span>
  </div>
);
