import type { ReactNode } from 'react';

/**
 * Shared page shell for the analysis views.
 *
 * The old right rail repeated generic methodology copy, consumed desktop width,
 * and became a long disclosure on phones. Keep the `rail` prop for page-level
 * compatibility while letting the primary tables, tabs, and charts carry the
 * explanation where the user is already looking.
 */
export const RailLayout = ({
  children,
}: {
  readonly children: ReactNode;
  /** @deprecated Kept so existing page composition remains source-compatible. */
  readonly rail?: ReactNode;
}) => (
  <div className="mx-auto max-w-[92rem] px-5 lg:pl-[4.75rem]">
    <div className="min-w-0 pb-8 lg:pb-20">{children}</div>
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
