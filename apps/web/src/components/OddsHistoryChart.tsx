/**
 * Playoff odds across the season, drawn as a line per team.
 *
 * A single week's number tells you where you stand; the shape over time tells
 * you where you're heading, which is the thing managers actually argue about.
 * Your own line is emphasised and everyone else recedes — the comparison
 * matters, but only as context for yours.
 *
 * Pure SVG rather than a charting library: one dependency less, and at this
 * size the library would be doing nothing a path element can't.
 */

export interface OddsPoint {
  readonly week: number;
  readonly playoffPct: number;
}

export interface TeamSeries {
  readonly teamId: string;
  readonly name: string;
  readonly points: readonly OddsPoint[];
  readonly isMine: boolean;
}

export const OddsHistoryChart = ({
  series,
  height = 200,
}: {
  series: readonly TeamSeries[];
  height?: number;
}) => {
  const weeks = [...new Set(series.flatMap((s) => s.points.map((p) => p.week)))].sort((a, b) => a - b);
  if (weeks.length < 2) return null;

  const width = 720;
  const padding = { top: 12, right: 48, bottom: 24, left: 32 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const minWeek = weeks[0]!;
  const maxWeek = weeks[weeks.length - 1]!;
  const x = (week: number) =>
    padding.left + ((week - minWeek) / Math.max(1, maxWeek - minWeek)) * plotWidth;
  const y = (value: number) => padding.top + (1 - value) * plotHeight;

  const path = (points: readonly OddsPoint[]) =>
    points
      .slice()
      .sort((a, b) => a.week - b.week)
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.week).toFixed(1)},${y(point.playoffPct).toFixed(1)}`)
      .join(' ');

  return (
    <div className="scroll-x">
      <svg width={width} height={height} role="img" aria-label="Playoff odds by week" style={{ maxWidth: '100%' }}>
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--rule)"
              strokeWidth={1}
            />
            <text x={4} y={y(tick) + 4} fontSize={10} fill="var(--ink-faint)">
              {tick * 100}%
            </text>
          </g>
        ))}

        {weeks.map((week) => (
          <text key={week} x={x(week)} y={height - 6} fontSize={10} fill="var(--ink-faint)" textAnchor="middle">
            {week}
          </text>
        ))}

        {/* Everyone else first, so your line draws on top of theirs. */}
        {series
          .filter((s) => !s.isMine)
          .map((s) => (
            <path key={s.teamId} d={path(s.points)} fill="none" stroke="var(--p-2)" strokeWidth={1.5} />
          ))}

        {series
          .filter((s) => s.isMine)
          .map((s) => {
            const last = [...s.points].sort((a, b) => a.week - b.week).at(-1);
            return (
              <g key={s.teamId}>
                <path d={path(s.points)} fill="none" stroke="var(--accent)" strokeWidth={2.5} />
                {last !== undefined && (
                  <>
                    <circle cx={x(last.week)} cy={y(last.playoffPct)} r={3.5} fill="var(--accent)" />
                    <text
                      x={x(last.week) + 8}
                      y={y(last.playoffPct) + 4}
                      fontSize={11}
                      fontWeight={600}
                      fill="var(--accent)"
                    >
                      {(last.playoffPct * 100).toFixed(0)}%
                    </text>
                  </>
                )}
              </g>
            );
          })}
      </svg>
    </div>
  );
};
