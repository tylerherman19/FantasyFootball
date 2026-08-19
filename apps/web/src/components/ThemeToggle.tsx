'use client';

/**
 * Light / dark, remembered.
 *
 * The stored choice is applied by a blocking script in the document head, not
 * by this component — by the time React hydrates the first paint has already
 * happened, and a theme applied in an effect means every dark-mode user sees a
 * white flash on every navigation.
 *
 * Which icon shows is decided by CSS reading the same `data-theme` attribute,
 * so the button is correct before hydration and there is no state to get out of
 * sync with the document. All this component contributes is the click.
 *
 * The head script itself lives in `lib/theme-script` — a server module — since
 * the root layout cannot depend on reading a constant back out of a client
 * module. See the comment there.
 */

import { THEME_STORAGE_KEY } from '@/lib/theme-script';

export type Theme = 'light' | 'dark';

export const ThemeToggle = () => {
  const toggle = () => {
    const root = document.documentElement;
    const next: Theme = root.dataset.theme === 'dark' ? 'light' : 'dark';

    // Suppress transitions for the swap itself, or every border and fill on a
    // dense page animates at once and the change reads as a stutter.
    root.classList.add('theme-switching');
    root.dataset.theme = next;
    window.setTimeout(() => root.classList.remove('theme-switching'), 0);

    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private browsing. The choice just won't outlive the tab.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Switch between light and dark theme"
      title="Switch between light and dark theme"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors"
      style={{ border: '1px solid var(--rule)', color: 'var(--ink-muted)' }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {/* Moon: offer dark. Shown while the page is light. */}
        <path
          className="theme-icon-light"
          d="M13.2 9.6A5.8 5.8 0 0 1 6.4 2.8a5.8 5.8 0 1 0 6.8 6.8Z"
          fill="currentColor"
        />

        {/* Sun: offer light. Shown while the page is dark. */}
        <g className="theme-icon-dark">
          <circle cx="8" cy="8" r="3.2" fill="currentColor" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
            <line
              key={angle}
              x1={8 + 5 * Math.cos((angle * Math.PI) / 180)}
              y1={8 + 5 * Math.sin((angle * Math.PI) / 180)}
              x2={8 + 6.8 * Math.cos((angle * Math.PI) / 180)}
              y2={8 + 6.8 * Math.sin((angle * Math.PI) / 180)}
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          ))}
        </g>
      </svg>
    </button>
  );
};
