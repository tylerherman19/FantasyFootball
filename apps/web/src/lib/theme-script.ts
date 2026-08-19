/**
 * The theme, applied before the first paint.
 *
 * Kept in its own server-safe module, deliberately. This string has to be
 * inlined into the document head by the root layout — a server component — and
 * the layout cannot reliably read a plain constant out of a `'use client'`
 * module: in an RSC build those exports are client *references*, not values.
 * It happens to work today because the bundler inlines the literal, which is a
 * bundler detail rather than a guarantee, and if it ever stopped working the
 * symptom would be a white flash on every navigation for every dark-mode user
 * rather than an error anyone would notice in review.
 *
 * So the script lives here, the button lives in ThemeToggle, and they share
 * only the storage key.
 */

export const THEME_STORAGE_KEY = 'ffe-theme';

export const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var dark = stored ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
`;
