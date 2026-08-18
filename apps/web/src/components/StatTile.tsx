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
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
}) => (
  <div className="p-4" style={{ background: 'var(--surface)' }}>
    <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
      {label}
    </div>
    <div
      className="tabular mt-1 text-2xl font-semibold"
      style={{ color: emphasis ? 'var(--accent)' : 'var(--ink)' }}
    >
      {value}
    </div>
    {sub !== undefined && (
      <div className="tabular mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
        {sub}
      </div>
    )}
  </div>
);
