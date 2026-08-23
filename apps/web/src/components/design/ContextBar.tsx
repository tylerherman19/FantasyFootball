'use client';

import { useEffect, useState } from 'react';

/**
 * Context that follows the reader down the page.
 *
 * The right-hand rail was the wrong shape for this. It held good material — how
 * a number was computed, what the model declined — but it sat in one place while
 * the reader moved, so by the time they reached the fourth section it was
 * explaining the first. Static context beside moving content is a footnote with
 * extra steps.
 *
 * This puts the same material in a bar under the header and swaps it as each
 * section comes into view. The apparatus is always about whatever is on screen,
 * which is what "drill down" should mean on a page you scroll rather than a page
 * you click through.
 *
 * Implemented with IntersectionObserver against a band near the top of the
 * viewport rather than the whole screen: with a full-height root, two sections
 * are visible at once for most of a scroll and the bar flickers between them.
 * Watching a narrow strip gives one unambiguous answer.
 *
 * Degrades to the first section's context without JS, which is the honest
 * fallback — better than an empty bar.
 */

export interface SectionContext {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly source?: string;
}

export const ContextBar = ({ sections }: { readonly sections: readonly SectionContext[] }) => {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? '');

  useEffect(() => {
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost section currently crossing the band wins. Sorting by
        // position rather than taking the first entry matters because the
        // observer reports in registration order, not document order.
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

        if (visible[0] !== undefined) setActiveId(visible[0].target.id);
      },
      {
        // A strip just below the sticky header: everything above and well below
        // is ignored, so exactly one section is "current" at a time.
        rootMargin: '-140px 0px -70% 0px',
        threshold: 0,
      },
    );

    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (element !== null) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [sections]);

  const active = sections.find((s) => s.id === activeId) ?? sections[0];
  if (active === undefined) return null;

  return (
    <div
      className="sticky top-[6.6rem] z-10 -mx-5 mb-6 border-b px-5 py-2 backdrop-blur"
      style={{
        borderColor: 'var(--rule)',
        background: 'color-mix(in srgb, var(--ground) 92%, transparent)',
      }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="eyebrow shrink-0" style={{ color: 'var(--accent)' }}>
          {active.label}
        </span>
        <span className="text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          {active.detail}
        </span>
        {active.source !== undefined && (
          <span
            className="shrink-0 text-[10px] uppercase tracking-widest"
            style={{ color: 'var(--ink-faint)' }}
          >
            {active.source}
          </span>
        )}
      </div>
    </div>
  );
};
