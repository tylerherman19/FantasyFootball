import Link from 'next/link';
import { matchupFor, shellLabel, type DefenseArtifact } from '@/lib/defense';
import { schemeBound, type SchemeFinding } from '@/lib/scheme-impact';

/**
 * The scheme read, wherever a player appears.
 *
 * Scheme had a page and nothing else, which is the wrong shape for it. Nobody
 * opens a scheme tab, memorises six defensive tendencies and walks back to the
 * decision holding them; and a page that exists only to be visited on purpose
 * is a page that mostly is not. The read belongs beside the player — on his
 * profile, on the waiver row, in the roster table — and the standalone page
 * belongs to the league-wide picture and the measurement behind it.
 *
 * What makes that safe to do everywhere is the bound. Sprinkling a red or green
 * matchup grade across the product would be worse than leaving it on one page:
 * it would nudge every decision by an amount the model has measured, three
 * times, at approximately zero. So the size travels with the read. A manager
 * who sees "squeezed — everything underneath" also sees that the whole effect
 * is worth ±0.05 points to this player, which is the difference between context
 * and a recommendation.
 */
export const SchemeLine = ({
  position,
  opponent,
  sd,
  defenses,
  finding,
  leagueId,
  compact = false,
}: {
  readonly position: string;
  /** The defense he faces, or null when he has no game this week. */
  readonly opponent: string | null;
  /** His own spread, which sets how many points the bound is worth to him. */
  readonly sd: number;
  readonly defenses: DefenseArtifact | null;
  readonly finding: SchemeFinding | null;
  readonly leagueId: string;
  /** One line, no detail — for table rows and dense lists. */
  readonly compact?: boolean;
}) => {
  if (defenses === null || opponent === null) return null;

  const profile = defenses.teams[opponent];
  if (profile === undefined) return null;

  const all = Object.values(defenses.teams);
  const effect = matchupFor(position, profile, all);
  const bound = schemeBound(sd, finding);
  const colour =
    effect.score > 0.25 ? 'var(--good)' : effect.score < -0.25 ? 'var(--bad)' : 'var(--ink-muted)';

  if (compact) {
    return (
      <span
        className="text-[11px]"
        style={{ color: colour }}
        title={`${effect.headline}. ${effect.detail}${
          Number.isNaN(bound) ? '' : ` Worth at most ±${bound.toFixed(2)} pts — scheme has been measured three times and moves a projection none of them.`
        }`}
      >
        {effect.headline}
      </span>
    );
  }

  return (
    <div className="border-l-2 pl-3" style={{ borderColor: colour }}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold" style={{ color: colour }}>
          {effect.headline}
        </span>
        <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
          vs {opponent} · {shellLabel(profile.shellIndex)}
        </span>
      </div>

      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        {effect.detail}
      </p>

      {/*
        * The disclaimer is the useful part, so it is a sentence rather than a
        * footnote in grey six point.
        */}
      {!Number.isNaN(bound) && (
        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
          Worth at most <strong>±{bound.toFixed(2)} pts</strong> to him. Opponent strength has been
          tested against this model three times — on points, on opportunity, and on the spread — and
          improved it none of the three, so this defensive matchup read is context and stays out
          of the projection. The player&apos;s own offensive scheme is accounted for upstream in the
          model&apos;s opportunity line.{' '}
          <Link href={`/league/${leagueId}/scheme`} className="underline">
            The measurement
          </Link>
          .
        </p>
      )}
    </div>
  );
};
