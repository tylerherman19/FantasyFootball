import type { Explanation } from '@/lib/explain';

/**
 * Where a projection came from, as a waterfall.
 *
 * Read left to right: a baseline, then each thing the model knows about this
 * player that moves him off it, ending on the number the rest of the product
 * quotes. The bars are the actual model terms — the steps sum to the total
 * exactly — so this is the model showing its working, not a caption.
 *
 * No card. A heading, bars, and the arithmetic.
 */

const money = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;

export const Why = ({
  explanation,
  className = '',
}: {
  readonly explanation: Explanation;
  readonly className?: string;
}) => {
  const { steps, total, isPrior } = explanation;

  // Scale to the largest quantity on screen so the baseline bar and the
  // adjustment bars are comparable rather than each filling their own row.
  const scale = Math.max(total, ...steps.map((s) => Math.abs(s.value)), 1);

  const hasScheme = steps.some((step) => step.label === 'Offensive scheme');

  return (
    <details className={className} open>
      <summary className="cursor-pointer text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
        Model components · {isPrior ? 'draft-capital prior' : hasScheme ? 'history · opportunity · offensive scheme · efficiency' : 'history · opportunity · efficiency'}
      </summary>
      <div className="mt-3">
      <table className="w-full">
        <tbody>
          {steps.map((step, index) => {
            const width = (Math.abs(step.value) / scale) * 100;
            const isBaseline = index === 0;
            const positive = step.value >= 0;

            return (
              <tr key={step.label} className="align-baseline">
                <td className="w-40 py-1 pr-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  {step.label}
                </td>
                <td className="py-1">
                  <div className="flex items-center gap-2">
                    <div className="relative h-2 flex-1" style={{ minWidth: '4rem' }}>
                      <div
                        className="absolute inset-y-0"
                        style={{
                          width: `${width}%`,
                          // The baseline is neutral: it is not a gain, it is
                          // where everyone at this position starts.
                          background: isBaseline
                            ? 'var(--ink-faint)'
                            : positive
                              ? 'var(--pos)'
                              : 'var(--neg)',
                          left: isBaseline || positive ? 0 : undefined,
                          right: !isBaseline && !positive ? `${100 - width}%` : undefined,
                        }}
                      />
                    </div>
                    <span
                      className="tabular w-14 shrink-0 text-right text-xs"
                      style={{
                        color: isBaseline
                          ? 'var(--ink-muted)'
                          : positive
                            ? 'var(--pos)'
                            : 'var(--neg)',
                      }}
                    >
                      {isBaseline ? step.value.toFixed(1) : money(step.value)}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}

          <tr className="align-baseline">
            <td
              className="border-t pt-2 pr-3 text-xs font-semibold"
              style={{ borderColor: 'var(--rule)' }}
            >
              Projection
            </td>
            <td className="border-t pt-2" style={{ borderColor: 'var(--rule)' }}>
              <div className="flex items-center gap-2">
                <div className="flex-1" />
                <span className="tabular w-14 shrink-0 text-right text-sm font-semibold">
                  {total.toFixed(1)}
                </span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <dl className="mt-3 space-y-1">
        {steps.map((step) => (
          <div key={step.label} className="text-xs leading-relaxed">
            <dt className="inline font-medium" style={{ color: 'var(--ink-muted)' }}>
              {step.label}:{' '}
            </dt>
            <dd className="inline" style={{ color: 'var(--ink-faint)' }}>
              {step.note}
            </dd>
          </div>
        ))}
      </dl>

      {explanation.scheme !== undefined && (
        <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
          Offensive context: <strong>{explanation.scheme.team || 'current team'}</strong> · pace{' '}
          {(explanation.scheme.paceMultiplier ?? 1).toFixed(3)}× · pass shape{' '}
          {(explanation.scheme.passShape ?? 1).toFixed(3)}× · run shape{' '}
          {(explanation.scheme.runShape ?? 1).toFixed(3)}×. These bounded multipliers changed
          opportunity; efficiency is shown separately above.
        </p>
      )}

      {!isPrior && (
        <p className="mt-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Built from {explanation.effectiveGames.toFixed(1)} recency-weighted games. Older games
          count for less; a game ten back counts half.
        </p>
      )}
      </div>
    </details>
  );
};

/**
 * How much the model trusts its own number, and what is holding it back.
 *
 * Shown next to every projection that has one. A confidence figure with no
 * stated reason is decoration — the reasons are the useful half, because they
 * are what a manager can actually check against what they know.
 */
export const Confidence = ({ explanation }: { readonly explanation: Explanation }) => {
  const pct = Math.round(explanation.confidence * 100);
  const tone = pct >= 65 ? 'var(--pos)' : pct >= 40 ? 'var(--warn)' : 'var(--neg)';

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="tabular text-lg font-semibold" style={{ color: tone }}>
          {pct}%
        </span>
        <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          confidence
        </span>
      </div>

      {explanation.confidenceReasons.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {explanation.confidenceReasons.map((reason) => (
            <li key={reason} className="text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
