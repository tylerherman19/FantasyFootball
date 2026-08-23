/**
 * Chart primitives.
 *
 * Hand-written SVG rather than a charting library, for three reasons that all
 * still hold: the shapes here are simple enough that a library would only be
 * wrapping `<rect>` and `<path>`; every chart is a server component, so a
 * client-side library would mean shipping and hydrating JavaScript to draw
 * something already known at render time; and the visual language — the
 * probability ramp, the position hues, the hairline grid — is shared with the
 * tables, which a library would fight rather than inherit.
 *
 * Every colour is a CSS token, which is what makes the whole set switch themes
 * without a single conditional.
 *
 * Conventions across all of them:
 * - `viewBox` plus `width: 100%` so charts scale with the column they're in.
 * - Values are labelled directly where there's room, rather than via a legend.
 * - Anything a reader would want to compare shares a scale with its neighbours.
 */

export const POSITION_COLOR: Readonly<Record<string, string>> = {
  QB: 'var(--pos-qb)',
  RB: 'var(--pos-rb)',
  WR: 'var(--pos-wr)',
  TE: 'var(--pos-te)',
  K: 'var(--pos-k)',
  DEF: 'var(--pos-def)',
  DL: 'var(--pos-dl)',
  LB: 'var(--pos-lb)',
  DB: 'var(--pos-db)',
};

export const positionColor = (position: string): string =>
  POSITION_COLOR[position] ?? 'var(--ink-faint)';

/**
 * Probability to colour, in five steps.
 *
 * Banded rather than continuous on purpose: a reader can hold five categories
 * in their head and compare cells across a table, where a smooth gradient just
 * says "bigger" and forces them back to the numbers.
 */
export const rampColor = (value: number): string => {
  if (value >= 0.8) return 'var(--p-max)';
  if (value >= 0.6) return 'var(--p-high)';
  if (value >= 0.4) return 'var(--p-mid)';
  if (value >= 0.15) return 'var(--p-low)';
  return 'var(--p-0)';
};

/** Text that stays legible on top of a ramp fill. */
export const rampInk = (value: number): string =>
  value >= 0.6 ? '#fff' : 'var(--ink)';

export const formatPct = (value: number, digits = 0): string =>
  `${(value * 100).toFixed(digits)}%`;

// --------------------------------------------------------------------------
// Position chip
// --------------------------------------------------------------------------

export const PositionChip = ({ position }: { position: string }) => (
  <span className="pos-chip" style={{ background: positionColor(position) }}>
    {position}
  </span>
);

// --------------------------------------------------------------------------
// Bar in a cell
// --------------------------------------------------------------------------

/**
 * A value drawn inside its own table cell.
 *
 * The workhorse: a column of these turns a column of numbers into a shape the
 * eye can rank without reading any of them.
 */
export const CellBar = ({
  value,
  max,
  color = 'var(--p-mid)',
  label,
  width = 84,
  height = 9,
}: {
  value: number;
  max: number;
  color?: string;
  label?: string;
  width?: number;
  height?: number;
}) => {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

  return (
    <span className="inline-flex items-center gap-2">
      <svg width={width} height={height} role="img" aria-label={label ?? String(value)}>
        <rect x={0} y={0} width={width} height={height} rx={2} fill="var(--p-0)" />
        <rect x={0} y={0} width={Math.max(share * width, share > 0 ? 1.5 : 0)} height={height} rx={2} fill={color} />
      </svg>
      {label !== undefined && (
        <span className="tabular text-xs" style={{ color: 'var(--ink-muted)' }}>
          {label}
        </span>
      )}
    </span>
  );
};

/**
 * A bar that can go either way from a centre line.
 *
 * For anything expressed as a difference — points above replacement, value
 * gained or lost in a trade, a team above or below the league average. The zero
 * line is drawn because on a diverging scale it is the only reference that
 * matters.
 */
export const DivergingBar = ({
  value,
  max,
  width = 120,
  height = 10,
  label,
}: {
  value: number;
  max: number;
  width?: number;
  height?: number;
  label?: string;
}) => {
  const half = width / 2;
  const share = max > 0 ? Math.max(-1, Math.min(1, value / max)) : 0;
  const length = Math.abs(share) * half;

  return (
    <span className="inline-flex items-center gap-2">
      <svg width={width} height={height} role="img" aria-label={label ?? String(value)}>
        <rect x={0} y={height / 2 - 0.5} width={width} height={1} fill="var(--rule)" />
        <rect
          x={share >= 0 ? half : half - length}
          y={1}
          width={Math.max(length, 1)}
          height={height - 2}
          rx={2}
          fill={share >= 0 ? 'var(--good)' : 'var(--bad)'}
        />
        <rect x={half - 0.5} y={0} width={1} height={height} fill="var(--rule-strong)" />
      </svg>
      {label !== undefined && (
        <span className="tabular text-xs" style={{ color: 'var(--ink-muted)' }}>
          {label}
        </span>
      )}
    </span>
  );
};

// --------------------------------------------------------------------------
// Stacked composition bar
// --------------------------------------------------------------------------

export interface StackSegment {
  readonly key: string;
  readonly value: number;
  readonly color: string;
  readonly label?: string;
}

/**
 * One row of a stacked bar chart — a total, broken into where it came from.
 *
 * This is the shape that answers "what is this team made of": two rosters worth
 * the same in total can be a balanced twelve or one quarterback and rubble, and
 * only the composition shows it.
 *
 * Segments narrower than a few pixels get no label rather than a clipped one.
 */
export const StackedBar = ({
  segments,
  max,
  width = 320,
  height = 18,
  showLabels = true,
}: {
  segments: readonly StackSegment[];
  max: number;
  width?: number;
  height?: number;
  showLabels?: boolean;
}) => {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const scale = max > 0 ? width / max : 0;

  // Offsets resolved up front rather than accumulated while mapping, so
  // rendering stays a pure function of the props.
  const lengths = segments.map((segment) => Math.max(0, segment.value) * scale);
  const offsets = lengths.reduce<number[]>(
    (positions, length, index) => [...positions, (positions[index] ?? 0) + length],
    [0],
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={segments.map((s) => `${s.key} ${Math.round(s.value)}`).join(', ')}
      style={{ display: 'block', maxWidth: width }}
    >
      <rect x={0} y={0} width={width} height={height} fill="var(--p-0)" rx={2} />
      {segments.map((segment, index) => {
        const length = lengths[index] ?? 0;
        const x = offsets[index] ?? 0;

        return (
          <g key={segment.key}>
            <title>{`${segment.key}: ${segment.value.toFixed(0)}${total > 0 ? ` (${formatPct(segment.value / total)})` : ''}`}</title>
            <rect x={x} y={0} width={Math.max(length - 0.75, 0)} height={height} fill={segment.color} />
            {showLabels && length > 26 && (
              <text
                x={x + length / 2}
                y={height / 2 + 3.5}
                fontSize={9}
                fontWeight={700}
                textAnchor="middle"
                fill="#fff"
                style={{ pointerEvents: 'none' }}
              >
                {segment.label ?? segment.key}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// --------------------------------------------------------------------------
// Distribution
// --------------------------------------------------------------------------

/**
 * A histogram with the mean and a threshold marked.
 *
 * Used everywhere an outcome is uncertain — final win totals, simulated points,
 * finishing rank. The threshold line is the point: "7 projected wins" is not
 * the answer to "do I make the playoffs", and the share of the distribution
 * past the cut is.
 */
export const Histogram = ({
  bins,
  labels,
  highlightFrom,
  mean,
  height = 88,
  color = 'var(--p-mid)',
  highlightColor = 'var(--accent)',
}: {
  bins: readonly number[];
  labels?: readonly string[];
  /** Bins at or past this index are drawn in the highlight colour. */
  highlightFrom?: number;
  mean?: number;
  height?: number;
  color?: string;
  highlightColor?: string;
}) => {
  const max = Math.max(...bins, 1e-9);
  const width = Math.max(bins.length * 18, 120);
  const barWidth = width / bins.length;

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        role="img"
        aria-label="Distribution"
        style={{ display: 'block' }}
      >
        {bins.map((share, index) => {
          const barHeight = share > 0 ? Math.max((share / max) * (height - 2), 1.5) : 0;
          const highlighted = highlightFrom !== undefined && index >= highlightFrom;

          return (
            <g key={index}>
              <title>{`${labels?.[index] ?? index}: ${formatPct(share, 1)}`}</title>
              <rect
                x={index * barWidth + 0.75}
                y={height - barHeight}
                width={Math.max(barWidth - 1.5, 1)}
                height={barHeight}
                fill={highlighted ? highlightColor : color}
                opacity={highlighted ? 1 : 0.75}
              />
            </g>
          );
        })}

        {mean !== undefined && mean >= 0 && mean <= bins.length && (
          <line
            x1={(mean + 0.5) * barWidth}
            x2={(mean + 0.5) * barWidth}
            y1={0}
            y2={height}
            stroke="var(--ink)"
            strokeWidth={1}
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {labels !== undefined && (
        <div className="mt-1 flex">
          {labels.map((label, index) => (
            <div key={index} className="axis-label flex-1 text-center">
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// --------------------------------------------------------------------------
// Heat map
// --------------------------------------------------------------------------

export interface HeatCell {
  /** 0-1, drives the fill. */
  readonly intensity: number;
  readonly label: string;
  readonly title?: string;
}

/**
 * A matrix, coloured by value.
 *
 * The densest thing here and the most useful: twelve teams across nine
 * positions is a hundred numbers, and as a table nobody reads it. As a heat map
 * the strong and weak spots are visible before a single cell is read, and the
 * numbers stay in place for whoever wants them.
 */
export const HeatMap = ({
  columns,
  rows,
  rowLabelWidth = 132,
  cellHeight = 26,
  highlightRow,
}: {
  columns: readonly string[];
  rows: readonly {
    readonly key: string;
    readonly label: string;
    readonly cells: readonly HeatCell[];
  }[];
  rowLabelWidth?: number;
  cellHeight?: number;
  highlightRow?: string;
}) => (
  <div className="scroll-x">
    <table className="w-full" style={{ minWidth: rowLabelWidth + columns.length * 58 }}>
      <thead>
        <tr>
          <th style={{ width: rowLabelWidth }} />
          {columns.map((column) => (
            <th key={column} className="axis-label pb-1 text-center font-semibold uppercase">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td
              className="truncate pr-2 text-xs"
              style={{
                maxWidth: rowLabelWidth,
                fontWeight: row.key === highlightRow ? 700 : 400,
                color: row.key === highlightRow ? 'var(--accent)' : 'var(--ink)',
              }}
            >
              {row.label}
            </td>
            {row.cells.map((cell, index) => (
              <td key={index} className="p-px">
                <div
                  title={cell.title}
                  className="tabular flex items-center justify-center rounded-[2px] text-[11px] font-medium"
                  style={{
                    height: cellHeight,
                    background: rampColor(cell.intensity),
                    color: rampInk(cell.intensity),
                  }}
                >
                  {cell.label}
                </div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// --------------------------------------------------------------------------
// Scatter
// --------------------------------------------------------------------------

export interface ScatterPoint {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly label?: string;
  readonly color?: string;
  readonly radius?: number;
  readonly emphasis?: boolean;
}

/**
 * Two measures against each other, with the quadrants named.
 *
 * A scatter earns its place when the *relationship* is the finding — age
 * against value, opportunity against production, price against what a player
 * actually does for your lineup. Median lines split it into quadrants, because
 * "expensive and productive" and "expensive and not" are the two groups a
 * manager is actually sorting into.
 */
export const Scatter = ({
  points,
  xLabel,
  yLabel,
  quadrantLabels,
  height = 260,
  width = 520,
  xMedian,
  yMedian,
}: {
  points: readonly ScatterPoint[];
  xLabel: string;
  yLabel: string;
  /** Clockwise from top-left. */
  quadrantLabels?: readonly [string, string, string, string];
  height?: number;
  width?: number;
  xMedian?: number;
  yMedian?: number;
}) => {
  if (points.length === 0) return null;

  const pad = { top: 16, right: 16, bottom: 30, left: 44 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);

  const xScale = (value: number) =>
    pad.left + ((value - xMin) / Math.max(xMax - xMin, 1e-9)) * plotWidth;
  const yScale = (value: number) =>
    pad.top + (1 - (value - yMin) / Math.max(yMax - yMin, 1e-9)) * plotHeight;

  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };

  const splitX = xMedian ?? median(xs);
  const splitY = yMedian ?? median(ys);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label={`${yLabel} against ${xLabel}`}
      style={{ display: 'block', color: 'var(--ink-faint)' }}
    >
      <rect
        x={pad.left}
        y={pad.top}
        width={plotWidth}
        height={plotHeight}
        fill="var(--surface-sunk)"
        stroke="var(--rule)"
      />

      <line
        x1={xScale(splitX)}
        x2={xScale(splitX)}
        y1={pad.top}
        y2={pad.top + plotHeight}
        stroke="var(--rule-strong)"
        strokeDasharray="3 3"
      />
      <line
        x1={pad.left}
        x2={pad.left + plotWidth}
        y1={yScale(splitY)}
        y2={yScale(splitY)}
        stroke="var(--rule-strong)"
        strokeDasharray="3 3"
      />

      {quadrantLabels !== undefined && (
        <>
          <text x={pad.left + 6} y={pad.top + 13} fontSize={9} opacity={0.75}>
            {quadrantLabels[0]}
          </text>
          <text x={pad.left + plotWidth - 6} y={pad.top + 13} fontSize={9} textAnchor="end" opacity={0.75}>
            {quadrantLabels[1]}
          </text>
          <text
            x={pad.left + plotWidth - 6}
            y={pad.top + plotHeight - 6}
            fontSize={9}
            textAnchor="end"
            opacity={0.75}
          >
            {quadrantLabels[2]}
          </text>
          <text x={pad.left + 6} y={pad.top + plotHeight - 6} fontSize={9} opacity={0.75}>
            {quadrantLabels[3]}
          </text>
        </>
      )}

      {points.map((point) => (
        <g key={point.key}>
          <title>{point.label ?? point.key}</title>
          <circle
            cx={xScale(point.x)}
            cy={yScale(point.y)}
            r={point.radius ?? 4}
            fill={point.color ?? 'var(--p-high)'}
            fillOpacity={point.emphasis === true ? 1 : 0.72}
            stroke={point.emphasis === true ? 'var(--ink)' : 'none'}
            strokeWidth={point.emphasis === true ? 1.5 : 0}
          />
          {/*
            * A transparent hit target, larger than the dot.
            *
            * The dots carry a title and were still effectively unhoverable: a
            * four-pixel radius asks for pixel-accurate aim, so the drill-down
            * was there in the markup and unreachable in practice. Twelve pixels
            * is a comfortable target and costs nothing visually.
            *
            * Rendered after the visible dot so it sits on top and always wins
            * the pointer, and `pointer-events: all` because a fill of `none`
            * would otherwise let the cursor straight through.
            */}
          <circle
            cx={xScale(point.x)}
            cy={yScale(point.y)}
            r={Math.max(12, (point.radius ?? 4) + 6)}
            fill="transparent"
            style={{ pointerEvents: 'all', cursor: 'help' }}
          >
            <title>{point.label ?? point.key}</title>
          </circle>
        </g>
      ))}

      <text x={pad.left + plotWidth / 2} y={height - 6} fontSize={10} textAnchor="middle">
        {xLabel}
      </text>
      <text
        x={-(pad.top + plotHeight / 2)}
        y={11}
        fontSize={10}
        textAnchor="middle"
        transform="rotate(-90)"
      >
        {yLabel}
      </text>
    </svg>
  );
};

// --------------------------------------------------------------------------
// Lines
// --------------------------------------------------------------------------

export interface LineSeries {
  readonly key: string;
  readonly label: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly color?: string;
  readonly emphasis?: boolean;
}

/**
 * Many series over a shared x, one of them yours.
 *
 * Everyone else is drawn first and in a receding colour so the comparison is
 * available without competing: the league is context for your line, not twelve
 * lines fighting for attention.
 */
export const LineChart = ({
  series,
  yFormat = (value) => value.toFixed(0),
  xLabel,
  yMax,
  yMin = 0,
  height = 220,
  width = 640,
  markLast = true,
}: {
  series: readonly LineSeries[];
  yFormat?: (value: number) => string;
  xLabel?: string;
  yMax?: number;
  yMin?: number;
  height?: number;
  width?: number;
  markLast?: boolean;
}) => {
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return null;

  const pad = { top: 12, right: 46, bottom: 26, left: 38 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const xs = all.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const top = yMax ?? Math.max(...all.map((p) => p.y));

  const xScale = (value: number) =>
    pad.left + ((value - xMin) / Math.max(xMax - xMin, 1e-9)) * plotWidth;
  const yScale = (value: number) =>
    pad.top + (1 - (value - yMin) / Math.max(top - yMin, 1e-9)) * plotHeight;

  const path = (points: readonly { x: number; y: number }[]) =>
    [...points]
      .sort((a, b) => a.x - b.x)
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${xScale(point.x).toFixed(1)},${yScale(point.y).toFixed(1)}`)
      .join(' ');

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => yMin + fraction * (top - yMin));
  const xTicks = [...new Set(xs)].sort((a, b) => a - b);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label={xLabel ?? 'Trend'}
      style={{ display: 'block', color: 'var(--ink-faint)' }}
    >
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={yScale(tick)}
            y2={yScale(tick)}
            stroke="var(--grid)"
          />
          <text x={pad.left - 5} y={yScale(tick) + 3.5} fontSize={9} textAnchor="end">
            {yFormat(tick)}
          </text>
        </g>
      ))}

      {xTicks.map((tick) => (
        <text key={tick} x={xScale(tick)} y={height - 8} fontSize={9} textAnchor="middle">
          {tick}
        </text>
      ))}

      {series
        .filter((s) => s.emphasis !== true)
        .map((s) => (
          <path
            key={s.key}
            d={path(s.points)}
            fill="none"
            stroke={s.color ?? 'var(--rule-strong)'}
            strokeWidth={1.25}
            opacity={0.8}
          />
        ))}

      {series
        .filter((s) => s.emphasis === true)
        .map((s) => {
          const last = [...s.points].sort((a, b) => a.x - b.x).at(-1);
          return (
            <g key={s.key}>
              <path d={path(s.points)} fill="none" stroke={s.color ?? 'var(--accent)'} strokeWidth={2.5} />
              {markLast && last !== undefined && (
                <>
                  <circle cx={xScale(last.x)} cy={yScale(last.y)} r={3.5} fill={s.color ?? 'var(--accent)'} />
                  <text
                    x={xScale(last.x) + 7}
                    y={yScale(last.y) + 3.5}
                    fontSize={10}
                    fontWeight={700}
                    fill={s.color ?? 'var(--accent)'}
                  >
                    {yFormat(last.y)}
                  </text>
                </>
              )}
            </g>
          );
        })}
    </svg>
  );
};

/** A trend small enough to sit inside a table row. */
export const Sparkline = ({
  values,
  width = 68,
  height = 18,
  color = 'var(--p-high)',
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  color?: string;
}) => {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1e-9);

  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - 1 - ((value - min) / span) * (height - 2);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} role="img" aria-label="Trend" style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
};

// --------------------------------------------------------------------------
// Range
// --------------------------------------------------------------------------

/**
 * A point estimate inside its plausible range.
 *
 * Whenever a number came out of a simulation, this is the honest way to show
 * it: the dot is the estimate, the bar is where the answer actually lives.
 * Ten thousand simulated seasons still leave a percentage point of noise, and a
 * reader who can see that stops over-reading week-to-week wobble.
 */
export const RangeBar = ({
  value,
  low,
  high,
  min = 0,
  max = 1,
  width = 130,
  height = 12,
  color = 'var(--p-high)',
}: {
  value: number;
  low: number;
  high: number;
  min?: number;
  max?: number;
  width?: number;
  height?: number;
  color?: string;
}) => {
  const scale = (input: number) =>
    ((Math.max(min, Math.min(max, input)) - min) / Math.max(max - min, 1e-9)) * width;

  return (
    <svg width={width} height={height} role="img" aria-label={`${value}`} style={{ display: 'block' }}>
      <rect x={0} y={height / 2 - 1} width={width} height={2} fill="var(--p-0)" rx={1} />
      <rect
        x={scale(low)}
        y={height / 2 - 3}
        width={Math.max(scale(high) - scale(low), 1.5)}
        height={6}
        fill={color}
        opacity={0.32}
        rx={3}
      />
      <rect x={0} y={height / 2 - 1} width={scale(value)} height={2} fill={color} rx={1} />
      <circle cx={scale(value)} cy={height / 2} r={3.25} fill={color} />
    </svg>
  );
};

// --------------------------------------------------------------------------
// Legend
// --------------------------------------------------------------------------

export const Legend = ({
  items,
}: {
  items: readonly { readonly label: string; readonly color: string }[];
}) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    {items.map((item) => (
      <span key={item.label} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
        <span className="h-2 w-2 rounded-[1px]" style={{ background: item.color }} />
        {item.label}
      </span>
    ))}
  </div>
);
