import type { Distribution as Dist } from '@/lib/distribution';

/**
 * A week as a range, not a number (§49).
 *
 * 538's habit, and the right one: show the interval, label it directly, and put
 * the annotation inside the chart rather than in a legend the reader has to
 * cross-reference. Two players projected 14.0 are not the same player if one
 * ranges 9–19 and the other 2–31, and only this says so.
 *
 * Every band carries a `title`, so hovering gives the exact figure without
 * cluttering the default view — the drill-down is there when wanted and silent
 * when not.
 */

const BANDS = [
  { from: 0, to: 4, opacity: 0.18, label: '10th–90th' },
  { from: 1, to: 3, opacity: 0.34, label: '25th–75th' },
] as const;

export const Distribution = ({
  distribution,
  width = 420,
  height = 64,
}: {
  readonly distribution: Dist;
  readonly width?: number;
  readonly height?: number;
}) => {
  const { percentiles, mean, truncated } = distribution;
  const p10 = percentiles[0]!.value;
  const p90 = percentiles[4]!.value;

  // Scale with headroom, and always start at zero — a fantasy week has a real
  // floor and hiding it would exaggerate every spread on the page.
  const max = Math.max(p90 * 1.08, mean * 1.3, 10);
  const x = (value: number): number => (Math.max(0, Math.min(max, value)) / max) * width;

  const axis = height - 16;
  const ticks = [0, max / 2, max].map((v) => Math.round(v / 5) * 5);

  return (
    <div>
      <svg width={width} height={height} role="img" aria-label={`Projection range ${p10.toFixed(1)} to ${p90.toFixed(1)}`}>
        {BANDS.map((band) => {
          const from = percentiles[band.from]!;
          const to = percentiles[band.to]!;
          return (
            <rect
              key={band.label}
              x={x(from.value)}
              y={12}
              width={Math.max(1, x(to.value) - x(from.value))}
              height={16}
              fill="var(--p-high)"
              opacity={band.opacity}
              rx={2}
            >
              <title>
                {band.label}: {from.value.toFixed(1)} – {to.value.toFixed(1)}
              </title>
            </rect>
          );
        })}

        {/* The projection itself, as a rule rather than a dot: it is a
            statement about the centre, not an outcome that will occur. */}
        <line x1={x(mean)} x2={x(mean)} y1={8} y2={32} stroke="var(--ink)" strokeWidth={2}>
          <title>Projection {mean.toFixed(1)}</title>
        </line>

        {/* Direct labels, in the chart. No legend to cross-reference. */}
        <text x={x(p10)} y={46} fontSize={10} fill="var(--ink-faint)" textAnchor="middle">
          {p10.toFixed(1)}
        </text>
        <text x={x(mean)} y={6} fontSize={10} fill="var(--ink)" textAnchor="middle" fontWeight={600}>
          {mean.toFixed(1)}
        </text>
        <text x={x(p90)} y={46} fontSize={10} fill="var(--ink-faint)" textAnchor="middle">
          {p90.toFixed(1)}
        </text>

        <line x1={0} x2={width} y1={axis} y2={axis} stroke="var(--rule)" strokeWidth={1} />
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={height - 2} fontSize={9} fill="var(--ink-faint)" textAnchor="middle">
            {t}
          </text>
        ))}
      </svg>

      {truncated && (
        <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Clamped at zero — the fitted spread runs below it, which a fantasy week cannot.
        </p>
      )}
    </div>
  );
};

/** Odds of clearing a threshold, which is how a manager actually thinks. */
export const ThresholdOdds = ({ distribution }: { readonly distribution: Dist }) => (
  <div className="flex flex-wrap gap-x-8 gap-y-2">
    {distribution.thresholds.map((t) => (
      <div key={t.threshold} title={`P(week ≥ ${t.threshold}) = ${(t.probability * 100).toFixed(1)}%`}>
        <div className="eyebrow mb-0.5">{t.threshold}+ points</div>
        <div
          className="tabular text-lg font-semibold"
          style={{
            color:
              t.probability >= 0.4 ? 'var(--pos)' : t.probability >= 0.15 ? 'var(--ink)' : 'var(--ink-muted)',
          }}
        >
          {(t.probability * 100).toFixed(0)}%
        </div>
      </div>
    ))}
  </div>
);
