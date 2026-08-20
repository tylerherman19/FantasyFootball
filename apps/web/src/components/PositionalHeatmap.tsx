import type { TeamStrength } from '@/lib/positional-strength';
import { HEATMAP_POSITIONS } from '@/lib/positional-strength';

/**
 * Where every roster in the league is strong, at a glance.
 *
 * A heat map is the right form here because the question is comparative and
 * two-dimensional — team against position — and the answer a manager wants is a
 * shape, not a number: which column is my hole, and who has a surplus there. A
 * table of forty numbers contains the same data and hides that shape completely.
 *
 * One hue, six steps, light to dark. Magnitude is a sequential encoding; using
 * two hues here would imply a midpoint that positional strength does not have.
 */

/** Sequential ramp, weakest to strongest. Six steps is as many as reads. */
const RAMP = ['var(--p-1)', 'var(--p-2)', 'var(--p-3)', 'var(--p-4)', 'var(--p-5)', 'var(--p-6)'];

const stepFor = (percentile: number): string =>
  RAMP[Math.min(RAMP.length - 1, Math.floor(percentile * RAMP.length))] ?? RAMP[0]!;

/** Dark cells need light text. The ramp crosses over around the fourth step. */
const inkFor = (percentile: number): string =>
  percentile >= 0.6 ? '#fff' : 'var(--ink)';

export const PositionalHeatmap = ({
  strengths,
  teamNames,
  myTeamId,
}: {
  readonly strengths: readonly TeamStrength[];
  readonly teamNames: ReadonlyMap<string, string>;
  readonly myTeamId: string | null;
}) => {
  // Strongest overall first, so the league's shape is legible top to bottom.
  const ordered = [...strengths].sort(
    (a, b) =>
      b.cells.reduce((sum, cell) => sum + cell.percentile, 0) -
      a.cells.reduce((sum, cell) => sum + cell.percentile, 0),
  );

  return (
    <section className="mb-12">
      <h2 className="kicker mb-1">Positional strength across the league</h2>
      <p className="standfirst mb-4">
        Projected starter points by position, ranked within this league — the only comparison that
        decides anything, since a strong quarterback room means something different in superflex.
        Your row is marked. Dark is strong.
      </p>

      <div className="scroll-x">
        <table className="min-w-[34rem]">
          <thead>
            <tr>
              <th style={{ width: '40%' }}>Team</th>
              {HEATMAP_POSITIONS.map((position) => (
                <th key={position} className="num" style={{ textAlign: 'center' }}>
                  {position}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((team) => {
              const isMine = team.teamId === myTeamId;
              return (
                <tr key={team.teamId}>
                  <td style={{ fontWeight: isMine ? 700 : 400 }}>
                    {teamNames.get(team.teamId) ?? team.teamId}
                    {isMine && (
                      <span
                        className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--accent)' }}
                      >
                        you
                      </span>
                    )}
                  </td>

                  {team.cells.map((cell) => (
                    <td key={cell.position} style={{ padding: '2px' }}>
                      {/*
                       * The number stays on the cell rather than living only in
                       * a tooltip: colour carries the comparison, the figure
                       * carries the magnitude, and neither is load-bearing
                       * alone — which is also what keeps this readable to a
                       * colour-blind reader and in print.
                       */}
                      <div
                        title={`${cell.points.toFixed(1)} projected points · ${cell.rank} of ${ordered.length} at ${cell.position}`}
                        className="tabular flex h-8 items-center justify-center text-xs font-semibold"
                        style={{
                          background: stepFor(cell.percentile),
                          color: inkFor(cell.percentile),
                        }}
                      >
                        {cell.points.toFixed(1)}
                      </div>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
        <span>Weakest</span>
        {RAMP.map((step) => (
          <span key={step} className="inline-block h-2.5 w-6" style={{ background: step }} />
        ))}
        <span>Strongest</span>
        <span className="ml-2">· in-league rank, not absolute points</span>
      </div>
    </section>
  );
};
