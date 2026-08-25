import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The shared vocabulary (§73).
 *
 * Every page here had been built independently, which is why the same idea — a
 * number with its league rank underneath — existed in four slightly different
 * shapes with four slightly different type scales. That is not a styling
 * problem; it is the product failing to look like one thing that knows one set
 * of facts.
 *
 * Three rules these encode, taken from the brief and applied here rather than
 * remembered per page:
 *
 * - **No card per statistic** (§74). Hierarchy comes from type, rule lines and
 *   whitespace. There is not a rounded rectangle in this file.
 * - **Every number carries context** (§67). `Metric` will not render without
 *   it, because a bare figure is the failure mode this product is trying to
 *   avoid.
 * - **Conclusion before evidence** (§42). `Insight` is ordered headline →
 *   evidence → recommendation, so a page composed of them reads as an argument
 *   rather than a dashboard.
 */

/**
 * A number, its label, and what it means.
 *
 * `context` is required. That is deliberate: "742" is not information, and the
 * type system is a better place to enforce that than a code review.
 */
export const Metric = ({
  label,
  value,
  context,
  tone,
  size = 'medium',
}: {
  readonly label: string;
  readonly value: string;
  readonly context: string;
  readonly tone?: string;
  readonly size?: 'medium' | 'large';
}) => (
  <div>
    <div className="eyebrow mb-1">{label}</div>
    <div
      className={`figure font-semibold ${size === 'large' ? 'text-3xl' : 'text-2xl'}`}
      style={tone === undefined ? undefined : { color: tone }}
    >
      {value}
    </div>
    <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>
      {context}
    </div>
  </div>
);

/** A row of metrics, spaced rather than boxed. */
export const MetricRow = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex flex-wrap gap-x-10 gap-y-5">{children}</div>
);

/**
 * Where a value sits in its distribution.
 *
 * A rank is more actionable than a raw figure for anything measured against 31
 * other teams or 200 other receivers, and a bar reads faster than a number.
 */
export const PercentileBar = ({
  percentile,
  width = 120,
  label,
}: {
  /** 0–1, where 1 is the top of the distribution. */
  readonly percentile: number;
  readonly width?: number;
  readonly label?: string;
}) => {
  const clamped = Math.max(0, Math.min(1, percentile));
  const tone = clamped >= 0.66 ? 'var(--pos)' : clamped <= 0.33 ? 'var(--neg)' : 'var(--ink-muted)';

  return (
    <div className="flex items-center gap-2">
      <svg
        width={width}
        height={8}
        role="img"
        aria-label={label ?? `${Math.round(clamped * 100)}th percentile`}
        style={{ display: 'block' }}
      >
        <rect x={0} y={3} width={width} height={2} fill="var(--p-0)" rx={1} />
        <rect x={0} y={3} width={clamped * width} height={2} fill={tone} rx={1} />
        <circle cx={clamped * width} cy={4} r={3} fill={tone} />
      </svg>
      <span className="tabular text-xs" style={{ color: 'var(--ink-faint)' }}>
        {Math.round(clamped * 100)}
        <span className="align-super text-[9px]">
          {['th', 'st', 'nd', 'rd'][
            Math.round(clamped * 100) % 10 <= 3 && Math.floor((Math.round(clamped * 100) % 100) / 10) !== 1
              ? Math.round(clamped * 100) % 10
              : 0
          ]}
        </span>
      </span>
    </div>
  );
};

export type InsightCategory =
  | 'lineup'
  | 'roster'
  | 'market'
  | 'trade'
  | 'waiver'
  | 'data'
  | 'model';

export interface InsightData {
  readonly category: InsightCategory;
  readonly headline: string;
  /** 0–1. Drives ordering, so the most consequential thing is read first. */
  readonly importance: number;
  readonly evidence: string;
  readonly recommendation?: string;
  readonly href?: string;
  readonly exploreLabel?: string;
}

const CATEGORY_LABEL: Record<InsightCategory, string> = {
  lineup: 'Lineup',
  roster: 'Roster',
  market: 'Market',
  trade: 'Trade',
  waiver: 'Waivers',
  data: 'Data',
  model: 'Model',
};

/**
 * One thing worth knowing, structured (§45).
 *
 * Ordered the way a 538 piece is ordered: what is true, then why you should
 * believe it, then what to do. The alternative — statistics first, conclusion
 * left to the reader — is what makes most fantasy tools exhausting rather than
 * useful.
 *
 * `recommendation` is optional on purpose. Not everything worth surfacing comes
 * with an action, and inventing one to fill the slot is how a product starts
 * telling people to do things it has no basis for.
 */
export const Insight = ({ insight, rank }: { readonly insight: InsightData; readonly rank: number }) => {
  const urgency = insight.importance >= 0.85 ? 'High' : insight.importance >= 0.6 ? 'Medium' : 'Watch';
  const tone = insight.importance >= 0.85 ? 'var(--accent)' : 'var(--p-high)';

  return (
    <article className="decision-row">
      <div className="decision-rank" aria-hidden="true">{String(rank).padStart(2, '0')}</div>
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="eyebrow">{CATEGORY_LABEL[insight.category]}</span>
          <span className="decision-urgency" style={{ color: tone }}>{urgency} priority</span>
        </div>
        <h3 className="text-[1.05rem] font-bold leading-tight tracking-tight">{insight.headline}</h3>
        {insight.recommendation !== undefined && (
          <p className="mt-1 text-sm font-medium">{insight.recommendation}</p>
        )}
        <details className="mt-2">
          <summary className="cursor-pointer text-xs" style={{ color: 'var(--ink-muted)' }}>
            Why this is here
          </summary>
          <p className="mt-1.5 max-w-2xl text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            {insight.evidence}
          </p>
        </details>
      </div>
      <div className="decision-action">
        <span className="decision-impact-track" aria-hidden="true">
          <span style={{ width: `${Math.round(insight.importance * 100)}%`, background: tone }} />
        </span>
        {insight.href !== undefined && (
          <Link href={insight.href} className="decision-link">
            {insight.exploreLabel ?? 'Open'} →
          </Link>
        )}
      </div>
    </article>
  );
};

/** Insights, most consequential first. */
export const InsightList = ({ insights }: { readonly insights: readonly InsightData[] }) => (
  <div>
    {[...insights]
      .sort((a, b) => b.importance - a.importance)
      .map((insight, index) => (
        <Insight key={`${insight.category}:${insight.headline}`} insight={insight} rank={index + 1} />
      ))}
  </div>
);
