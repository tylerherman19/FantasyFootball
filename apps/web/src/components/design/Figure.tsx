import type { ReactNode } from 'react';

/**
 * The shape every chart in this product takes.
 *
 * Lifted from FiveThirtyEight's house style, which is not a look so much as an
 * argument about order: **headline, deck, chart, source**. The headline states
 * the finding in words — "Baltimore hands off inside the twenty", not "Red-zone
 * tendency" — the deck qualifies it, the chart shows it, and the source line
 * says where the numbers came from.
 *
 * That ordering is the whole point (§42, §63). A chart titled "Red-zone
 * tendency" makes the reader derive the conclusion; a chart titled with the
 * conclusion lets them check it. The first is a dashboard. The second is
 * journalism, and it is what a manager can act on in the thirty seconds they
 * actually have.
 *
 * The source line is not decoration either. A figure without a source is an
 * assertion, and this product's entire claim is that its numbers can be
 * interrogated.
 */
export const Figure = ({
  headline,
  deck,
  source,
  note,
  children,
  className = '',
}: {
  /** The finding, in words. Not a category name. */
  readonly headline: string;
  /** One or two sentences of qualification. */
  readonly deck?: ReactNode;
  /** Where the numbers came from. */
  readonly source?: string;
  /** A caveat that belongs under the chart rather than above it. */
  readonly note?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <figure className={`mb-10 ${className}`}>
    <h2 className="headline mb-1.5">{headline}</h2>
    {deck !== undefined && <p className="deck mb-4">{deck}</p>}

    {children}

    {note !== undefined && (
      <figcaption className="mt-3 max-w-3xl text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        {note}
      </figcaption>
    )}

    {source !== undefined && <div className="source-line">Source: {source}</div>}
  </figure>
);

/**
 * A value labelled where it sits, rather than in a legend.
 *
 * Legends make the eye travel: read the colour, cross to the key, come back,
 * repeat for every series. Direct labels do not, which is why the reference
 * puts "Fandango" in red next to the red line instead of in a box underneath.
 *
 * Positioned by the caller because only the caller knows where the series ends.
 */
export const DirectLabel = ({
  x,
  y,
  children,
  color = 'var(--ink)',
  anchor = 'start',
}: {
  readonly x: number;
  readonly y: number;
  readonly children: string;
  readonly color?: string;
  readonly anchor?: 'start' | 'middle' | 'end';
}) => (
  <text
    x={x}
    y={y}
    fontSize={11}
    fontWeight={600}
    fill={color}
    textAnchor={anchor}
    style={{ paintOrder: 'stroke', stroke: 'var(--ground)', strokeWidth: 3 }}
  >
    {children}
  </text>
);

/**
 * An annotation inside the plot, pointing at what matters.
 *
 * The reference does this constantly — "Vertical line represents 80%
 * uncertainty interval" sitting in the whitespace of the chart rather than in a
 * caption. It works because the reader's eye is already in the plot area, and
 * moving it out to read prose and back again is where comprehension leaks.
 */
export const Annotation = ({
  x,
  y,
  children,
  anchor = 'start',
  width = 150,
}: {
  readonly x: number;
  readonly y: number;
  readonly children: ReactNode;
  readonly anchor?: 'start' | 'middle' | 'end';
  readonly width?: number;
}) => (
  <foreignObject
    x={anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x}
    y={y}
    width={width}
    height={54}
    style={{ overflow: 'visible', pointerEvents: 'none' }}
  >
    <div
      className="text-[10px] leading-snug"
      style={{ color: 'var(--ink-faint)', textAlign: anchor === 'end' ? 'right' : 'left' }}
    >
      {children}
    </div>
  </foreignObject>
);
