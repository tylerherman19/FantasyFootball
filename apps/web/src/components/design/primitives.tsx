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
      className={`tabular font-semibold ${size === 'large' ? 'text-3xl' : 'text-2xl'}`}
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
export const Insight = ({ insight }: { readonly insight: InsightData }) => (
  <div className="border-t py-4 first:border-t-0 first:pt-0" style={{ borderColor: 'var(--rule)' }}>
    <div className="mb-1 flex items-baseline gap-3">
      <span className="eyebrow" style={{ color: 'var(--ink-faint)' }}>
        {CATEGORY_LABEL[insight.category]}
      </span>
    </div>

    <h3 className="mb-1.5 text-base font-semibold leading-snug">{insight.headline}</h3>

    <p className="mb-2 max-w-3xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
      {insight.evidence}
    </p>

    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {insight.recommendation !== undefined && (
        <span className="text-sm font-medium">{insight.recommendation}</span>
      )}
      {insight.href !== undefined && (
        <Link href={insight.href} className="text-xs underline" style={{ color: 'var(--ink-muted)' }}>
          {insight.exploreLabel ?? 'Explore'}
        </Link>
      )}
    </div>
  </div>
);

/** Insights, most consequential first. */
export const InsightList = ({ insights }: { readonly insights: readonly InsightData[] }) => (
  <div>
    {[...insights]
      .sort((a, b) => b.importance - a.importance)
      .map((insight) => (
        <Insight key={`${insight.category}:${insight.headline}`} insight={insight} />
      ))}
  </div>
);
