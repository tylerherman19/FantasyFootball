import type { SourceFreshness } from '@ffe/ingest';

/**
 * How old the numbers are, on screen, always.
 *
 * A quantitative product that will not say when it last looked is asking to be
 * trusted on faith. This is deliberately small and permanent rather than a page
 * someone has to think to visit — the moment freshness is somewhere else is the
 * moment it stops being checked.
 *
 * It is also the honest reporting of a real failure: the weekly refresh had
 * never run, and nothing in the interface could have told you.
 *
 * Not a card. A line of text and a dot, sitting in the header where a
 * timestamp belongs.
 */

const TONE: Record<string, { dot: string; label: string }> = {
  healthy: { dot: 'var(--pos)', label: 'Current' },
  stale: { dot: 'var(--warn)', label: 'Stale' },
  failing: { dot: 'var(--neg)', label: 'Failing' },
  never: { dot: 'var(--neg)', label: 'Never run' },
  unknown: { dot: 'var(--ink-muted)', label: 'Unknown' },
};

/** "4 minutes ago" — plain words, because a raw ISO string is not an answer. */
export const humanAge = (minutes: number | null): string => {
  if (minutes === null) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
};

const worstOf = (sources: readonly SourceFreshness[]): string => {
  if (sources.length === 0) return 'unknown';
  if (sources.some((s) => s.health === 'failing' || s.health === 'never')) return 'failing';
  if (sources.some((s) => s.health === 'stale')) return 'stale';
  return 'healthy';
};

export const Freshness = ({
  sources,
  modelGeneratedAt,
}: {
  readonly sources: readonly SourceFreshness[];
  readonly modelGeneratedAt: string | null;
}) => {
  const overall = worstOf(sources);
  const tone = TONE[overall] ?? TONE.unknown!;

  const modelAge =
    modelGeneratedAt === null
      ? null
      : Math.round((Date.now() - Date.parse(modelGeneratedAt)) / 60_000);

  return (
    <details className="group text-xs" style={{ color: 'var(--ink-muted)' }}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 whitespace-nowrap">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: tone.dot }}
        />
        <span>
          Data {tone.label.toLowerCase()}
          {modelAge !== null && ` · model ${humanAge(modelAge)}`}
        </span>
      </summary>

      <div
        className="mt-2 min-w-64 border-t pt-2"
        style={{ borderColor: 'var(--rule)' }}
      >
        {sources.length === 0 ? (
          <p className="leading-relaxed">
            Freshness is not being recorded. Apply{' '}
            <code>supabase/migrations/0003_data_freshness.sql</code> and set{' '}
            <code>CRON_SECRET</code> to turn it on.
          </p>
        ) : (
          <table className="w-full tabular-nums">
            <tbody>
              {sources.map((source) => {
                const rowTone = TONE[source.health] ?? TONE.unknown!;
                return (
                  <tr key={source.source} className="align-baseline">
                    <td className="py-0.5 pr-3">
                      <span
                        aria-hidden
                        className="mr-1.5 inline-block h-1 w-1 rounded-full align-middle"
                        style={{ background: rowTone.dot }}
                      />
                      {source.label}
                    </td>
                    <td className="py-0.5 text-right">{humanAge(source.ageMinutes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Named rather than hidden: a failure the interface swallows is how
            this product came to serve four-day-old data while looking fine. */}
        {sources
          .filter((s) => s.lastError !== null && s.consecutiveFailures > 0)
          .map((s) => (
            <p key={s.source} className="mt-2 leading-relaxed" style={{ color: 'var(--neg)' }}>
              {s.label}: {s.consecutiveFailures} consecutive failure
              {s.consecutiveFailures === 1 ? '' : 's'} — {s.lastError}
            </p>
          ))}
      </div>
    </details>
  );
};
