'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Context that follows the reader down the page.
 *
 * The right-hand rail was the wrong shape for this. It held good material — how
 * a number was computed, what the model declined — but it sat in one place
 * while the reader moved, so by the time they reached the fourth section it was
 * explaining the first. Static context beside moving content is a footnote with
 * extra steps, and on a phone it was worse than that: a 19rem column with
 * nowhere to go collapses to a wall of grey text below everything, which is
 * where context goes to die.
 *
 * This puts the current section's own deck in a bar under the header and swaps
 * it as each section comes into view. The apparatus is always about whatever is
 * on screen, which is what "drill down" should mean on a page you scroll rather
 * than one you click through — and it works identically at 380px and 1600px,
 * which the rail never could.
 *
 * **It discovers its own sections.** An earlier version took a `sections` prop,
 * which meant every page restating its own headings in a second place — two
 * lists to keep in sync, and a silent wrong answer the moment they drifted.
 * `Section` already emits a stable id and renders its deck with a known class,
 * so the bar reads the page it is actually on. Pages wire nothing.
 */

/** Longer than this and the bar becomes a paragraph, which defeats it. */
const MAX_DETAIL = 190;

interface Discovered {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly source: string;
}

const readSections = (): Discovered[] => {
  const found: Discovered[] = [];

  for (const element of document.querySelectorAll<HTMLElement>('section[id^="s-"]')) {
    const heading = element.querySelector('h2');
    if (heading === null) continue;

    const deck = element.querySelector('.deck');
    const source = element.querySelector('.source-line');

    const detail = (deck?.textContent ?? '').replace(/\s+/g, ' ').trim();

    found.push({
      id: element.id,
      label: (heading.textContent ?? '').replace(/\s+/g, ' ').trim(),
      detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1).trimEnd()}…` : detail,
      source: (source?.textContent ?? '').replace(/^Source:\s*/, '').replace(/\s+/g, ' ').trim(),
    });
  }

  return found;
};

export const ContextBar = () => {
  const [sections, setSections] = useState<Discovered[]>([]);
  const [activeId, setActiveId] = useState('');
  const barRef = useRef<HTMLDivElement>(null);

  // Discover once the page has painted. Sections are server-rendered, so they
  // are present on the first pass — no need to poll for late arrivals.
  useEffect(() => {
    const found = readSections();
    setSections(found);
    setActiveId(found[0]?.id ?? '');
  }, []);

  /*
   * Sit directly beneath the header rather than at a guessed offset.
   *
   * The header is sticky and changes height as it collapses on scroll, so any
   * hard-coded `top` is wrong at one of the two sizes — either the bar hides
   * under the header or it floats below it with a stripe of page showing
   * through. Measuring is a few lines and correct at every width.
   */
  useEffect(() => {
    const header = document.querySelector<HTMLElement>('[data-league-nav]');
    if (header === null || barRef.current === null) return;

    const bar = barRef.current;
    const apply = () => {
      bar.style.top = `${header.getBoundingClientRect().height}px`;
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, [sections.length]);

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
        /*
         * A strip near the top of the viewport, not the whole screen.
         *
         * With a full-height root two sections are visible at once for most of
         * a scroll and the bar flickers between them. Watching a narrow band
         * gives one unambiguous answer. The band is generous at the bottom
         * (-55%) so that a short section still claims it on the way past.
         */
        rootMargin: '-120px 0px -55% 0px',
        threshold: 0,
      },
    );

    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (element !== null) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [sections]);

  // Nothing to say on a page with no sections, and nothing to say before
  // hydration — rendering an empty bar would just be a grey stripe.
  if (sections.length === 0) return null;

  const active = sections.find((s) => s.id === activeId) ?? sections[0];
  if (active === undefined) return null;

  return (
    <div
      ref={barRef}
      className="sticky z-10 -mx-5 mb-5 border-b px-5 py-2 backdrop-blur"
      style={{
        top: 0,
        borderColor: 'var(--rule)',
        background: 'color-mix(in srgb, var(--ground) 93%, transparent)',
      }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="eyebrow shrink-0" style={{ color: 'var(--accent)' }}>
          {active.label}
        </span>

        {active.detail !== '' && (
          <span
            className="hidden text-xs leading-relaxed sm:inline"
            style={{ color: 'var(--ink-muted)' }}
          >
            {active.detail}
          </span>
        )}

        {active.source !== '' && (
          <span
            className="shrink-0 truncate text-[10px] uppercase tracking-widest"
            style={{ color: 'var(--ink-faint)' }}
          >
            {active.source}
          </span>
        )}
      </div>
    </div>
  );
};
