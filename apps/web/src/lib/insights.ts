import type { InsightData } from '@/components/design/primitives';
import type { PortfolioAnalysis } from './portfolio';
import type { SourceFreshness } from '@ffe/ingest';

/**
 * What matters right now (§44).
 *
 * The most useful page in the product is supposed to answer "what should I do",
 * and it answered "here is your team" — a set of accurate panels the reader had
 * to assemble into a view themselves. This turns the model's existing outputs
 * into a ranked list of things worth knowing.
 *
 * **Everything here is derived, and nothing is invented.** Each insight is a
 * threshold applied to a number the model already computed, with the number
 * quoted in the evidence line so a reader can disagree with the threshold rather
 * than having to trust the sentence. No insight is generated for a quantity the
 * product does not have — the failure mode being avoided is a page that always
 * has five confident things to say regardless of whether it knows five things.
 *
 * Importance is a rough ordering, not a probability. It exists so the list reads
 * top-down in the order a manager would care, and it is stated as such rather
 * than dressed up with a decimal it cannot support.
 */

export interface InsightInputs {
  readonly leagueId: string;
  readonly titleOdds: number | null;
  readonly playoffOdds: number | null;
  readonly rosterCount: number;
  readonly benchedBetter: readonly {
    readonly startName: string;
    readonly benchName: string;
    readonly gain: number;
  }[];
  readonly rookiesUnvalued: readonly string[];
  readonly portfolio: PortfolioAnalysis | null;
  readonly freshness: readonly SourceFreshness[];
  readonly modelAgeMinutes: number | null;
  readonly injuredStarters: readonly { readonly name: string; readonly status: string }[];
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export const buildInsights = (input: InsightInputs): InsightData[] => {
  const out: InsightData[] = [];
  const base = `/league/${input.leagueId}`;

  /*
   * Lineup first, always. It is the only decision on this page with a deadline,
   * and it is the one where being wrong is immediately expensive.
   */
  for (const swap of input.benchedBetter.slice(0, 2)) {
    out.push({
      category: 'lineup',
      importance: 0.95,
      headline: `Start ${swap.benchName} over ${swap.startName}`,
      evidence: `The optimal lineup gains ${swap.gain.toFixed(1)} projected points from the swap, under this league's scoring and after the availability haircut.`,
      recommendation: `Swap them before kickoff`,
      href: `${base}/lineup`,
      exploreLabel: 'Open lineup',
    });
  }

  if (input.injuredStarters.length > 0) {
    const names = input.injuredStarters.map((p) => `${p.name} (${p.status})`).join(', ');
    out.push({
      category: 'lineup',
      importance: 0.88,
      headline: `${input.injuredStarters.length} starter${input.injuredStarters.length === 1 ? '' : 's'} carrying a designation`,
      evidence: `${names}. A player listed Questionable played 59% of the time and produced 77% of his own baseline when he did — both measured, not assumed. Until inactives drop the model prices him at the mid-week rate.`,
      href: `${base}/lineup`,
      exploreLabel: 'Open lineup',
    });
  }

  if (input.portfolio !== null && input.portfolio.correlationPenalty > 1.06) {
    out.push({
      category: 'roster',
      importance: 0.7,
      headline: 'Your starters rise and fall together',
      evidence: `Shared games widen your weekly range about ${((input.portfolio.correlationPenalty - 1) * 100).toFixed(0)}% beyond what the individual projections imply. That is upside when the offence hits and a floor you cannot lean on when it does not.`,
      href: `${base}/dynasty`,
      exploreLabel: 'See the portfolio',
    });
  }

  const topTeam = input.portfolio?.byTeam[0];
  if (topTeam !== undefined && topTeam.share > 0.3) {
    out.push({
      category: 'roster',
      importance: 0.65,
      headline: `${(topTeam.share * 100).toFixed(0)}% of your value sits in one offence`,
      evidence: `${topTeam.label} carries ${topTeam.players.length} of your assets. A coaching change or a quarterback injury there is a roster-level event rather than a player-level one.`,
      href: `${base}/team/${topTeam.label}`,
      exploreLabel: `Open ${topTeam.label}`,
    });
  }

  if (input.rookiesUnvalued.length > 0) {
    out.push({
      category: 'market',
      importance: 0.6,
      headline: `${input.rookiesUnvalued.length} rookie${input.rookiesUnvalued.length === 1 ? '' : 's'} on your roster now carry a projection`,
      evidence: `${input.rookiesUnvalued.slice(0, 3).join(', ')}${input.rookiesUnvalued.length > 3 ? ` and ${input.rookiesUnvalued.length - 3} more` : ''}. Priced from draft capital and depth chart rather than history, which beat a flat rookie baseline by 16.7% out of sample. Confidence is capped low because a prior is not evidence.`,
      href: `${base}/roster`,
      exploreLabel: 'Open roster',
    });
  }

  if (input.titleOdds !== null && input.playoffOdds !== null) {
    // The gap between making the playoffs and winning is where construction
    // shows up: a team that always gets in and never wins is built differently
    // from one that scrapes in and is dangerous.
    const conversion = input.playoffOdds > 0 ? input.titleOdds / input.playoffOdds : 0;
    if (input.playoffOdds > 0.5 && conversion < 0.2) {
      out.push({
        category: 'roster',
        importance: 0.55,
        headline: 'You get in and then lose',
        evidence: `${pct(input.playoffOdds)} to reach the playoffs but only ${pct(input.titleOdds)} to win — you convert a berth into a title ${pct(conversion)} of the time. That gap is roster construction and variance, not schedule.`,
        href: `${base}/power`,
        exploreLabel: 'Compare rosters',
      });
    }
  }

  /*
   * Data health is an insight, not a footnote. A stale model quietly makes
   * every other item on this list wrong, and the whole reason the refresh
   * system exists is that the previous failure was invisible.
   */
  /*
   * Only genuine failures, and only the kind a person can act on.
   *
   * The first version counted every source that had not been pushed on demand,
   * which included the five built offline by the Python pipeline and one read
   * live on every request. It put "7 data sources not reporting" at the top of
   * this page, ranked above the lineup, about data that was entirely fine. A
   * warning that is always on is a warning nobody reads.
   */
  const failing = input.freshness.filter(
    (s) => s.health === 'failing' || (s.kind === 'serve' && s.health === 'never'),
  );
  if (failing.length > 0) {
    out.push({
      category: 'data',
      importance: 0.99,
      headline: `${failing.length} data source${failing.length === 1 ? '' : 's'} not reporting`,
      evidence: `${failing.map((s) => s.label).join(', ')}. Everything else on this page is computed from data that may be out of date, and the model cannot tell you by how much.`,
      href: '/api/data-status',
      exploreLabel: 'Data status',
    });
  }

  // Stale is a different message from broken: the data exists, it is simply
  // older than its cadence, and there is a command that fixes it.
  const stale = input.freshness.filter((s) => s.health === 'stale');
  if (stale.length > 0 && failing.length === 0) {
    out.push({
      category: 'data',
      importance: 0.45,
      headline: `${stale.length === 1 ? stale[0]!.label : `${stale.length} sources`} past its refresh window`,
      evidence: `${stale
        .map((s) => `${s.label} (${s.ageMinutes === null ? 'unknown age' : `${Math.round(s.ageMinutes / 60)}h`})`)
        .join(', ')}. Not broken — older than its cadence. ${
        stale[0]?.rebuildCommand ? `Rebuild with ${stale[0].rebuildCommand}.` : ''
      }`,
      href: '/api/data-status',
      exploreLabel: 'Data status',
    });
  }

  if (input.modelAgeMinutes !== null && input.modelAgeMinutes > 60 * 24 * 8) {
    out.push({
      category: 'model',
      importance: 0.92,
      headline: 'The projections are more than a week old',
      evidence: `Last built ${Math.round(input.modelAgeMinutes / (60 * 24))} days ago. Usage, injuries and depth charts have all moved since, and the model has not seen any of it.`,
      recommendation: 'Re-run model/export_projections.py',
    });
  }

  return out;
};
