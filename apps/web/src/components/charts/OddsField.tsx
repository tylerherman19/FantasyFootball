import { Annotation, DirectLabel } from '@/components/design/Figure';

/**
 * The whole league on one axis, with you on it.
 *
 * The lead chart the home page did not have. It opened with a ranked list of
 * text, and a ranked list cannot show the thing that actually decides a dynasty
 * season: whether the league is tightly bunched — in which case one trade moves
 * you several places — or already split into a top two and everyone else, in
 * which case it does not.
 *
 * A strip plot rather than a bar chart, deliberately. Bars invite you to compare
 * lengths, which is the wrong comparison here; what matters is the *gaps*
 * between teams, and a strip puts those in front of you. It is the same reason
 * the reference plots seats-lost against approval as points rather than as bars.
 *
 * Every dot hovers to its team and both probabilities.
 */

export interface OddsPoint {
  readonly teamId: string;
  readonly name: string;
  readonly titlePct: number;
  readonly playoffPct: number;
  readonly isMine: boolean;
}

export const OddsField = ({
  teams,
  width = 720,
  height = 150,
}: {
  readonly teams: readonly OddsPoint[];
  readonly width?: number;
  readonly height?: number;
}) => {
  if (teams.length === 0) return null;

  const pad = { left: 8, right: 8, top: 18, bottom: 46 };
  const plot = width - pad.left - pad.right;

  const max = Math.max(...teams.map((t) => t.titlePct), 0.05);
  // Rounded up to a clean tick so the axis reads in round numbers.
  const ceiling = Math.ceil(max * 100 / 5) * 5 / 100;
  const x = (p: number): number => pad.left + (p / ceiling) * plot;

  const sorted = [...teams].sort((a, b) => a.titlePct - b.titlePct);

  /*
   * Stack only where dots would collide, so a bunched league reads as bunched
   * rather than as a single blob. Positions are computed up front because the
   * reader's own dot needs a label placed against *its* row, not against the
   * top of the plot — a label floating four rows above the thing it names is
   * worse than no label.
   */
  const rows: number[] = [];
  const placed = sorted.map((team) => {
    const px = x(team.titlePct);
    let row = 0;
    while (rows[row] !== undefined && px - rows[row]! < 22) row += 1;
    rows[row] = px;
    return { team, px, py: pad.top + row * 15 };
  });

  const mine = placed.find((p) => p.team.isMine);

  const ticks = [0, ceiling / 2, ceiling];

  return (
    <svg width={width} height={height} role="img" aria-label="Championship probability across the league">
      {/* Axis first, so dots sit on top of it. */}
      <line
        x1={pad.left}
        x2={width - pad.right}
        y1={height - pad.bottom + 8}
        y2={height - pad.bottom + 8}
        stroke="var(--rule)"
      />
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={x(t)}
            x2={x(t)}
            y1={pad.top - 12}
            y2={height - pad.bottom + 8}
            stroke="var(--grid)"
            strokeWidth={1}
          />
          <text
            x={x(t)}
            y={height - pad.bottom + 22}
            fontSize={10}
            fill="var(--ink-faint)"
            textAnchor="middle"
          >
            {(t * 100).toFixed(0)}%
          </text>
        </g>
      ))}

      {placed.map(({ team, px, py }) => {
        return (
          <g key={team.teamId}>
            <circle
              cx={px}
              cy={py}
              r={team.isMine ? 6 : 4.5}
              fill={team.isMine ? 'var(--accent)' : 'var(--p-high)'}
              opacity={team.isMine ? 1 : 0.55}
              stroke={team.isMine ? 'var(--ground)' : 'none'}
              strokeWidth={2}
            >
              <title>
                {team.name} — {(team.titlePct * 100).toFixed(1)}% to win,{' '}
                {(team.playoffPct * 100).toFixed(0)}% to reach the playoffs
              </title>
            </circle>
          </g>
        );
      })}

      {/* Direct label against the reader's own dot, not floating above the plot. */}
      {mine !== undefined && (
        <DirectLabel x={mine.px} y={mine.py + 20} anchor="middle" color="var(--accent)">
          You
        </DirectLabel>
      )}

      {/* Below the axis, where nothing can collide with it. */}
      <Annotation x={pad.left} y={height - pad.bottom + 26} width={width - pad.left - pad.right}>
        Each dot is a team. Gaps matter more than order — a bunched field means one move changes
        everything.
      </Annotation>
    </svg>
  );
};
