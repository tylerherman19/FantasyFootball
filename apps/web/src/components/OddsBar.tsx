/**
 * A probability, drawn with its uncertainty.
 *
 * The bar is the estimate; the lighter band around it is the Monte Carlo
 * standard error. Showing it is the point — a 61% playoff chance from 4,000
 * iterations carries about +/- 0.8 points of noise, and a reader who sees that
 * stops over-reading a two-point move between weeks.
 */
export const OddsBar = ({
  probability,
  iterations,
  width = 120,
}: {
  probability: number;
  iterations: number;
  width?: number;
}) => {
  const standardError = Math.sqrt(Math.max(probability * (1 - probability), 0) / iterations);
  const low = Math.max(0, probability - 1.96 * standardError);
  const high = Math.min(1, probability + 1.96 * standardError);

  const tone =
    probability >= 0.66 ? 'var(--p-6)' : probability >= 0.33 ? 'var(--p-4)' : 'var(--p-2)';

  return (
    <div className="flex items-center gap-2">
      <svg width={width} height={12} role="img" aria-label={`${(probability * 100).toFixed(0)} percent`}>
        <rect x={0} y={4} width={width} height={4} fill="var(--rule)" rx={2} />
        <rect
          x={low * width}
          y={3}
          width={Math.max(1, (high - low) * width)}
          height={6}
          fill={tone}
          opacity={0.35}
          rx={3}
        />
        <rect x={0} y={4} width={probability * width} height={4} fill={tone} rx={2} />
      </svg>
      <span className="tabular text-sm" style={{ color: 'var(--ink)' }}>
        {(probability * 100).toFixed(0)}%
      </span>
    </div>
  );
};
